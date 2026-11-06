const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const resources = path.join(__dirname, '../../Sources/MarkdownWebView/Resources')
const bundledScript = fs.readFileSync(path.join(resources, 'script'), 'utf8')
const template = fs.readFileSync(path.join(resources, 'template'), 'utf8')

function loadRenderer({ texmath, katex } = {}) {
  const renderedElement = { innerHTML: '' }
  const renderedMessages = []
  const context = vm.createContext({
    document: {
      getElementById: () => renderedElement,
      querySelectorAll: () => []
    },
    ResizeObserver: class {
      observe() {}
    },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    webkit: {
      messageHandlers: {
        renderedContentHandler: { postMessage: value => renderedMessages.push(value) },
        sizeChangeHandler: { postMessage() {} }
      }
    },
    texmath,
    katex
  })
  context.window = context
  context.self = context
  vm.runInContext(bundledScript, context, { filename: 'Resources/script' })
  for (const match of template.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim() === 'PLACEHOLDER_SCRIPT') continue
    vm.runInContext(match[1], context, { filename: 'Resources/template' })
  }
  return {
    render(markdown) {
      context.updateWithMarkdownContentBase64Encoded(Buffer.from(markdown, 'utf8').toString('base64'))
      return renderedElement.innerHTML
    },
    renderedMessages
  }
}

test('ordinary Markdown renders when both remote math scripts are unavailable', () => {
  const renderer = loadRenderer()
  const markdown = '# 日本語 📚\n\nA **saved** note with [a link](https://example.com/).'
  const html = renderer.render(markdown)
  assert.match(html, /<h1>日本語 📚<\/h1>/)
  assert.match(html, /<strong>saved<\/strong>/)
  assert.match(html, /<a href="https:\/\/example.com\/">a link<\/a>/)
  assert.deepEqual(renderer.renderedMessages, [Buffer.from(markdown, 'utf8').toString('base64')])
})

test('a missing math plugin does not prevent updates when KaTeX loaded', () => {
  const renderer = loadRenderer({ katex: { renderToString() {} } })
  assert.match(renderer.render('First paragraph'), /<p>First paragraph<\/p>/)
  assert.match(renderer.render('Updated **paragraph**'), /<strong>paragraph<\/strong>/)
})

test('a missing KaTeX engine leaves math text readable without installing its plugin', () => {
  let pluginCalls = 0
  const renderer = loadRenderer({ texmath() { pluginCalls++ } })
  const html = renderer.render('The expression is $x + y$.')
  assert.equal(pluginCalls, 0)
  assert.match(html, /The expression is \$x \+ y\$\./)
})

test('the math plugin receives its engine and options when both scripts loaded', () => {
  const katex = { renderToString() {} }
  let installedOptions
  const renderer = loadRenderer({
    katex,
    texmath(markdownIt, options) {
      installedOptions = options
      markdownIt.core.ruler.push('math-plugin-control', state => {
        state.tokens.find(token => token.type === 'inline').content += ' plugin-enabled'
      })
    }
  })
  assert.equal(installedOptions.engine, katex)
  assert.equal(installedOptions.katexOptions.throwOnError, false)
  assert.ok(installedOptions.delimiters.includes('dollars'))
  assert.match(renderer.render('**Online** rendering'), /<strong>Online<\/strong>/)
})
