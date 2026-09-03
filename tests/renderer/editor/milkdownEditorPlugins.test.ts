import { Schema, type Node as ProseNode } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { describe, expect, it } from 'vitest'

import { wrapInTaskList } from '@renderer/editor/milkdownEditorPlugins'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
    bullet_list: {
      attrs: { spread: { default: false } },
      content: 'list_item+',
      group: 'block'
    },
    ordered_list: {
      attrs: { order: { default: 1 }, spread: { default: false } },
      content: 'list_item+',
      group: 'block'
    },
    list_item: {
      attrs: {
        checked: { default: null },
        label: { default: '•' },
        listType: { default: 'bullet' },
        spread: { default: false }
      },
      content: 'paragraph block*'
    }
  }
})

function paragraph(text: string): ProseNode {
  return schema.node('paragraph', null, schema.text(text))
}

describe('wrapInTaskList', () => {
  it('turns every selected paragraph into a separate task item', () => {
    const doc = schema.node('doc', null, [
      paragraph('First'),
      paragraph('Second'),
      paragraph('Third')
    ])
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, doc.content.size - 1)
    })
    let nextState: EditorState | undefined

    const changed = wrapInTaskList(schema.nodes.bullet_list, schema.nodes.list_item)(
      state,
      (transaction) => {
        nextState = state.apply(transaction)
      }
    )

    expect(changed).toBe(true)
    const list = nextState?.doc.firstChild
    expect(list?.type).toBe(schema.nodes.bullet_list)
    expect(list?.childCount).toBe(3)
    expect(list?.content.content.map((item) => item.attrs.checked)).toEqual([
      false,
      false,
      false
    ])
    expect(list?.content.content.map((item) => item.textContent)).toEqual([
      'First',
      'Second',
      'Third'
    ])
  })
})
