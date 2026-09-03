import { exitCode } from '@milkdown/prose/commands'
import type { Node as ProseNode, NodeType } from '@milkdown/prose/model'
import { liftListItem, wrapInList } from '@milkdown/prose/schema-list'
import {
  type Command,
  Plugin,
  type Selection,
  TextSelection
} from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import {
  bulletListSchema,
  linkSchema,
  listItemSchema,
  orderedListSchema
} from '@milkdown/preset-commonmark'
import { $command, $prose, $useKeymap } from '@milkdown/utils'

import { findHttpUrlRanges } from '@renderer/utils/markdown-autolink'
import { renderOpenProjectHtml } from '@renderer/utils/openproject-html'

/**
 * Render the HTML OpenProject stores in a description, inside the editor.
 *
 * The read view already does this (`utils/openproject-html.ts`), but the editor
 * had the same problem for the same reason and needed its own fix: Milkdown's
 * `html` node is an atom whose `toDOM` sets `textContent`, so a description
 * with a screenshot in it showed `<figure class="op-uc-figure"><img …>` as
 * literal text in the place the image belongs.
 *
 * A node **view** rather than a redefined schema, which matters: the node's
 * `attrs.value` is left untouched, and `toMarkdown` writes it back verbatim. So
 * this changes what the user sees and nothing about what is saved — an
 * unrecognised construct still round-trips character for character.
 *
 * `innerHTML` is safe here on the same terms as the read view's `v-html`:
 * `renderOpenProjectHtml` **rebuilds** each construct it recognises, keeping
 * only `src`, `alt` and `title` re-escaped, and returns `null` for everything
 * else — which falls through to showing the raw text, exactly as before.
 */
export const openProjectHtmlNodeView = $prose(() => {
  return new Plugin({
    props: {
      nodeViews: {
        html: (node) => {
          const raw = String(node.attrs.value ?? '')
          const dom = document.createElement('span')
          dom.dataset.type = 'html'
          dom.classList.add('op-uc-html')

          const rendered = renderOpenProjectHtml(raw)
          if (rendered === null) {
            // Not on the recognised list, so show it as the text it is. Same
            // outcome as Milkdown's own `toDOM`.
            dom.textContent = raw
          } else {
            dom.innerHTML = rendered
          }

          // An atom node: ProseMirror owns the selection and there is nothing
          // inside for it to manage, so the view reports no content DOM.
          return { dom }
        }
      }
    }
  })
})

/** Add link marks to plain absolute HTTP(S) URLs as the document changes. */
export const autoLinkPlugin = $prose((ctx) => {
  const linkType = linkSchema.type(ctx)

  return new Plugin({
    appendTransaction: (transactions, _oldState, newState) => {
      if (!transactions.some((transaction) => transaction.docChanged)) return null

      const transaction = newState.tr
      let changed = false

      newState.doc.descendants((node, position) => {
        if (!node.isTextblock || node.type.spec.code) return

        let chunk = ''
        let chunkStart = 0

        const processChunk = (): void => {
          if (!chunk) return

          for (const range of findHttpUrlRanges(chunk)) {
            const from = position + 1 + chunkStart + range.start
            const to = position + 1 + chunkStart + range.end
            let isAlreadyLinked = true
            let hasIncompatibleLink = false

            newState.doc.nodesBetween(from, to, (textNode) => {
              if (!textNode.isText) return
              const mark = linkType.isInSet(textNode.marks)
              if (!mark) {
                isAlreadyLinked = false
                return
              }

              const href = String(mark.attrs.href ?? '')
              if (href !== range.href) isAlreadyLinked = false
              if (!range.href.startsWith(href) && !href.startsWith(range.href)) {
                hasIncompatibleLink = true
              }
            })

            if (hasIncompatibleLink) continue
            if (!isAlreadyLinked) {
              transaction.addMark(from, to, linkType.create({ href: range.href }))
              changed = true
            }

            // A link mark can be inclusive while the URL is being typed. Keep
            // terminal sentence punctuation visible but outside the anchor.
            const trailingCharacter = chunk.at(range.end)
            if (trailingCharacter && '.,!?;:])}'.includes(trailingCharacter)) {
              const trailingMark = newState.doc.resolve(to).marks().find(
                (mark) =>
                  mark.type === linkType &&
                  (range.href.startsWith(String(mark.attrs.href ?? '')) ||
                    String(mark.attrs.href ?? '').startsWith(range.href))
              )
              if (trailingMark) {
                transaction.removeMark(to, to + 1, linkType)
                changed = true
              }
            }
          }
        }

        node.forEach((child, offset) => {
          if (child.isText && child.text) {
            if (!chunk) chunkStart = offset
            chunk += child.text
            return
          }

          processChunk()
          chunk = ''
        })

        processChunk()
      })

      if (!changed) return null
      return transaction.setMeta('addToHistory', false)
    }
  })
})

/**
 * Leave a code block when Enter is pressed on its empty final line.
 * The preceding newline is removed so the empty escape line is not saved.
 */
const exitCodeBlockOnEmptyLine: Command = (state, dispatch) => {
  const { $head, $anchor, empty } = state.selection
  const codeBlock = $head.parent

  if (
    !empty ||
    !$head.sameParent($anchor) ||
    !codeBlock.type.spec.code ||
    $head.parentOffset !== codeBlock.content.size ||
    !codeBlock.textContent.endsWith('\n')
  ) {
    return false
  }

  const container = $head.node(-1)
  const insertionIndex = $head.indexAfter(-1)
  const paragraphType = container.contentMatchAt(insertionIndex).defaultType
  if (!paragraphType || !container.canReplaceWith(insertionIndex, insertionIndex, paragraphType)) {
    return false
  }

  if (dispatch) {
    const paragraph = paragraphType.createAndFill()
    if (!paragraph) return false

    const cursorPosition = $head.pos
    const positionAfterCodeBlock = $head.after()
    const transaction = state.tr.delete(cursorPosition - 1, cursorPosition)
    const insertionPosition = transaction.mapping.map(positionAfterCodeBlock)

    transaction.insert(insertionPosition, paragraph)
    transaction.setSelection(TextSelection.create(transaction.doc, insertionPosition + 1))
    dispatch(transaction.scrollIntoView())
  }

  return true
}

export const codeBlockExitKeymap = $useKeymap('appCodeBlockExit', {
  ExitCodeBlockOnEmptyLine: {
    shortcuts: 'Enter',
    priority: 100,
    command: () => exitCodeBlockOnEmptyLine
  },
  ExitCodeBlockDirectly: {
    shortcuts: 'Mod-Enter',
    priority: 100,
    command: () => exitCode
  }
})

function selectedListItemPositions(
  doc: ProseNode,
  selection: Selection,
  listItemType: NodeType
): number[] {
  const positions = new Set<number>()

  const addAncestor = (position: number): void => {
    const resolved = doc.resolve(position)
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      if (resolved.node(depth).type === listItemType) {
        positions.add(resolved.before(depth))
        break
      }
    }
  }

  addAncestor(selection.from)
  addAncestor(selection.to)
  doc.nodesBetween(selection.from, selection.to, (node, position) => {
    if (node.type === listItemType) positions.add(position)
  })

  return [...positions].sort((left, right) => left - right)
}

/** Wrap every selected text block in its own unchecked task-list item. */
export function wrapInTaskList(listType: NodeType, listItemType: NodeType): Command {
  return (state, dispatch) =>
    wrapInList(listType)(
      state,
      dispatch
        ? (transaction) => {
            const wrappedPositions = selectedListItemPositions(
              transaction.doc,
              transaction.selection,
              listItemType
            )
            for (const position of wrappedPositions) {
              const item = transaction.doc.nodeAt(position)
              if (item?.type !== listItemType) continue
              transaction.setNodeMarkup(position, undefined, {
                ...item.attrs,
                checked: false
              })
            }
            dispatch(transaction.scrollIntoView())
          }
        : undefined
    )
}

export type MarkdownListKind = 'bullet' | 'ordered' | 'task'

/** The list type at the selection head, used by the toolbar's pressed state. */
export function getActiveListKind(selection: Selection): MarkdownListKind | null {
  const { $from } = selection
  let hasTaskItem = false

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)
    if (node.type.name === 'list_item' && node.attrs.checked != null) {
      hasTaskItem = true
    }
    if (node.type.name === 'ordered_list') return hasTaskItem ? 'task' : 'ordered'
    if (node.type.name === 'bullet_list') return hasTaskItem ? 'task' : 'bullet'
  }

  return null
}

/** Create, change, or remove the selected list type. */
export const toggleMarkdownListCommand = $command<MarkdownListKind, 'ToggleMarkdownList'>(
  'ToggleMarkdownList',
  (ctx) => (kind = 'bullet') => (state, dispatch) => {
    const listItemType = listItemSchema.type(ctx)
    const bulletListType = bulletListSchema.type(ctx)
    const orderedListType = orderedListSchema.type(ctx)
    const targetListType = kind === 'ordered' ? orderedListType : bulletListType
    const activeKind = getActiveListKind(state.selection)
    const { $from } = state.selection
    let listDepth = -1

    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const type = $from.node(depth).type
      if (type === bulletListType || type === orderedListType) {
        listDepth = depth
        break
      }
    }

    if (listDepth > 0) {
      if (activeKind === kind) {
        return liftListItem(listItemType)(state, dispatch)
      }

      const list = $from.node(listDepth)
      const listPosition = $from.before(listDepth)
      if (!targetListType.validContent(list.content)) return false
      if (!dispatch) return true

      const transaction = state.tr.setNodeMarkup(
        listPosition,
        targetListType,
        kind === 'ordered'
          ? { order: 1, spread: Boolean(list.attrs.spread) }
          : { spread: Boolean(list.attrs.spread) }
      )

      list.forEach((_item, offset, index) => {
        const itemPosition = listPosition + 1 + offset
        const item = transaction.doc.nodeAt(itemPosition)
        if (item?.type !== listItemType) return
        transaction.setNodeMarkup(itemPosition, undefined, {
          ...item.attrs,
          label: kind === 'ordered' ? `${index + 1}.` : '•',
          listType: kind === 'ordered' ? 'ordered' : 'bullet',
          checked: kind === 'task' ? Boolean(item.attrs.checked) : null
        })
      })

      dispatch(transaction.scrollIntoView())
      return true
    }

    if (kind === 'task') {
      return wrapInTaskList(targetListType, listItemType)(state, dispatch)
    }

    return wrapInList(targetListType)(state, dispatch)
  }
)

/** Render task items as accessible checkboxes and persist clicks to Markdown. */
export const taskListCheckboxPlugin = $prose((ctx) => {
  const listItemType = listItemSchema.type(ctx)

  return new Plugin({
    props: {
      decorations: (state) => {
        const decorations: Decoration[] = []
        state.doc.descendants((node, position) => {
          if (node.type !== listItemType || node.attrs.checked == null) return

          const checked = Boolean(node.attrs.checked)
          decorations.push(
            Decoration.widget(
              position + 1,
              () => {
                const checkbox = document.createElement('input')
                checkbox.type = 'checkbox'
                checkbox.checked = checked
                checkbox.className = 'task-list-checkbox'
                checkbox.dataset.taskPosition = String(position)
                checkbox.setAttribute(
                  'aria-label',
                  checked ? 'Mark task incomplete' : 'Mark task complete'
                )
                checkbox.contentEditable = 'false'
                return checkbox
              },
              { key: `task-checkbox-${position}-${checked}`, side: -1 }
            )
          )
        })
        return DecorationSet.create(state.doc, decorations)
      },
      handleDOMEvents: {
        change: (view, event) => {
          const target = event.target
          if (!(target instanceof HTMLInputElement) || !target.matches('.task-list-checkbox')) {
            return false
          }

          if (!view.editable) {
            target.checked = !target.checked
            return true
          }

          const position = Number(target.dataset.taskPosition)
          const item = view.state.doc.nodeAt(position)
          if (!Number.isInteger(position) || item?.type !== listItemType) return false

          view.dispatch(
            view.state.tr.setNodeMarkup(position, undefined, {
              ...item.attrs,
              checked: target.checked
            })
          )
          return true
        }
      }
    }
  })
})
