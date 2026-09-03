import {
  commandsCtx,
  defaultValueCtx,
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
  type CmdKey
} from '@milkdown/core'
import { history, redoCommand, undoCommand } from '@milkdown/plugin-history'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import {
  commonmark,
  createCodeBlockCommand,
  linkSchema,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  updateLinkCommand,
  wrapInBlockquoteCommand,
  wrapInHeadingCommand
} from '@milkdown/preset-commonmark'
import { gfm, toggleStrikethroughCommand } from '@milkdown/preset-gfm'
import { TextSelection } from '@milkdown/prose/state'
import { replaceAll } from '@milkdown/utils'
import {
  onBeforeUnmount,
  onMounted,
  shallowRef,
  watch,
  type Ref,
  type ShallowRef
} from 'vue'

import {
  autoLinkPlugin,
  codeBlockExitKeymap,
  getActiveListKind,
  type MarkdownListKind,
  taskListCheckboxPlugin,
  toggleMarkdownListCommand
} from '@renderer/editor/milkdownEditorPlugins'

interface UseMilkdownEditorOptions {
  disabled: () => boolean
  label: string
  markdown: Ref<string>
  placeholder?: string
  root: Readonly<ShallowRef<HTMLElement | null>>
}

/**
 * Owns the imperative Milkdown/ProseMirror boundary for the Vue editor shell.
 *
 * The public value remains Markdown. Milkdown's document model exists only
 * while the component is mounted and is synchronized in both directions so a
 * parent can still replace a draft while the same form component is alive.
 */
export function useMilkdownEditor(options: UseMilkdownEditorOptions) {
  const editor = shallowRef<Editor | null>(null)
  const error = shallowRef<Error | null>(null)
  const isReady = shallowRef(false)
  const activeList = shallowRef<MarkdownListKind | null>(null)
  let disposed = false
  let lastEditorMarkdown = options.markdown.value

  function run<T>(command: CmdKey<T>, payload?: T): boolean {
    const instance = editor.value
    if (!instance) return false

    return instance.action((ctx) => {
      const didRun = ctx.get(commandsCtx).call(command, payload)
      const view = ctx.get(editorViewCtx)
      activeList.value = getActiveListKind(view.state.selection)
      view.focus()
      return didRun
    })
  }

  const toggleBold = (): boolean => run(toggleStrongCommand.key)
  const toggleItalic = (): boolean => run(toggleEmphasisCommand.key)
  const toggleStrikethrough = (): boolean => run(toggleStrikethroughCommand.key)
  const toggleInlineCode = (): boolean => run(toggleInlineCodeCommand.key)
  const createCodeBlock = (): boolean => run(createCodeBlockCommand.key, '')
  const setHeading = (level: 1 | 2 | 3): boolean => run(wrapInHeadingCommand.key, level)
  const toggleBulletList = (): boolean => run(toggleMarkdownListCommand.key, 'bullet')
  const toggleOrderedList = (): boolean => run(toggleMarkdownListCommand.key, 'ordered')
  const toggleTaskList = (): boolean => run(toggleMarkdownListCommand.key, 'task')
  const toggleBlockquote = (): boolean => run(wrapInBlockquoteCommand.key)
  const undo = (): boolean => run(undoCommand.key)
  const redo = (): boolean => run(redoCommand.key)

  function activeLinkHref(): string | null {
    const instance = editor.value
    if (!instance) return null

    return instance.action((ctx) => {
      const { state } = ctx.get(editorViewCtx)
      const markType = linkSchema.type(ctx)
      const { from, to, $from } = state.selection
      const directMark = markType.isInSet(state.storedMarks ?? $from.marks())
      if (directMark) return String(directMark.attrs.href ?? '') || null

      let href: string | null = null
      state.doc.nodesBetween(from, to, (node) => {
        const mark = markType.isInSet(node.marks)
        if (mark) {
          href = String(mark.attrs.href ?? '') || null
          return false
        }
        return undefined
      })
      return href
    })
  }

  function setLink(href: string): boolean {
    const instance = editor.value
    if (!instance) return false

    return instance.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const { state } = view
      const markType = linkSchema.type(ctx)
      const existing = activeLinkHref()

      if (existing) {
        const updated = ctx.get(commandsCtx).call(updateLinkCommand.key, { href })
        view.focus()
        return updated
      }

      if (state.selection.empty) {
        const { from } = state.selection
        const end = from + href.length
        const transaction = state.tr.insertText(href, from).addMark(
          from,
          end,
          markType.create({ href })
        )
        transaction.setSelection(TextSelection.create(transaction.doc, end)).scrollIntoView()
        view.dispatch(transaction)
        view.focus()
        return true
      }

      const linked = ctx.get(commandsCtx).call(toggleLinkCommand.key, { href })
      view.focus()
      return linked
    })
  }

  function removeLink(): boolean {
    const instance = editor.value
    if (!instance) return false

    return instance.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const { state } = view
      const markType = linkSchema.type(ctx)
      const { $from, empty, from, to } = state.selection
      let start = from
      let end = to

      if (empty) {
        const parent = $from.parent
        const parentStart = $from.start()
        const cursorOffset = $from.parentOffset
        const children: Array<{ end: number; href: string | null; start: number }> = []
        let offset = 0

        parent.forEach((node) => {
          const childStart = offset
          offset += node.nodeSize
          const mark = markType.isInSet(node.marks)
          children.push({
            start: childStart,
            end: offset,
            href: mark ? String(mark.attrs.href ?? '') || null : null
          })
        })

        const index = children.findIndex(
          (child) => child.href && cursorOffset >= child.start && cursorOffset <= child.end
        )
        if (index < 0) return false

        const href = children[index]?.href
        let first = index
        let last = index
        while (first > 0 && children[first - 1]?.href === href) first -= 1
        while (last < children.length - 1 && children[last + 1]?.href === href) last += 1

        start = parentStart + (children[first]?.start ?? cursorOffset)
        end = parentStart + (children[last]?.end ?? cursorOffset)
      }

      if (start === end) return false
      view.dispatch(state.tr.removeMark(start, end, markType).scrollIntoView())
      view.focus()
      return true
    })
  }

  onMounted(async () => {
    const root = options.root.value
    if (!root) {
      error.value = new Error('Markdown editor root is unavailable')
      return
    }

    try {
      const instance = Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root)
          ctx.set(defaultValueCtx, options.markdown.value)
          ctx.update(editorViewOptionsCtx, (previous) => ({
            ...previous,
            editable: () => !options.disabled(),
            attributes: {
              ...previous.attributes,
              'aria-label': options.label,
              'aria-multiline': 'true',
              'aria-disabled': String(options.disabled()),
              'data-placeholder': options.placeholder ?? '',
              class: 'milkdown-editor'
            }
          }))
          ctx
            .get(listenerCtx)
            .markdownUpdated((_listenerCtx, markdown, previousMarkdown) => {
              lastEditorMarkdown = markdown
              if (markdown !== previousMarkdown && options.markdown.value !== markdown) {
                options.markdown.value = markdown
              }
            })
            .selectionUpdated((_listenerCtx, selection) => {
              activeList.value = getActiveListKind(selection)
            })
            .updated((listenerContext) => {
              activeList.value = getActiveListKind(
                listenerContext.get(editorViewCtx).state.selection
              )
            })
            .mounted((listenerContext) => {
              activeList.value = getActiveListKind(
                listenerContext.get(editorViewCtx).state.selection
              )
            })
        })
        .use(commonmark)
        .use(gfm)
        .use(autoLinkPlugin)
        .use(codeBlockExitKeymap)
        .use(taskListCheckboxPlugin)
        .use(toggleMarkdownListCommand)
        .use(history)
        .use(listener)

      await instance.create()
      if (disposed) {
        await instance.destroy()
        return
      }

      editor.value = instance
      isReady.value = true
    } catch (cause) {
      error.value = cause instanceof Error ? cause : new Error(String(cause))
    }
  })

  watch(options.markdown, (markdown) => {
    const instance = editor.value
    if (!instance || markdown === lastEditorMarkdown) return

    lastEditorMarkdown = markdown
    instance.action(replaceAll(markdown))
  })

  watch(options.disabled, (disabled) => {
    const instance = editor.value
    if (!instance) return

    instance.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.setProps({ editable: () => !disabled })
      view.dom.setAttribute('aria-disabled', String(disabled))
    })
  })

  onBeforeUnmount(() => {
    disposed = true
    const instance = editor.value
    editor.value = null
    isReady.value = false
    if (instance) void instance.destroy()
  })

  return {
    activeLinkHref,
    activeList,
    createCodeBlock,
    error,
    isReady,
    redo,
    removeLink,
    setHeading,
    setLink,
    toggleBlockquote,
    toggleBold,
    toggleBulletList,
    toggleInlineCode,
    toggleItalic,
    toggleOrderedList,
    toggleStrikethrough,
    toggleTaskList,
    undo
  }
}
