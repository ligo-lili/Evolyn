function toJSON(todo) {
  return { id: todo.id, text: todo.text, done: todo.done ? 1 : 0 };
}

function fromJSON(obj) {
  return { id: obj.id, text: obj.text, done: obj.done === 1 };
}

module.exports = { toJSON, fromJSON };
