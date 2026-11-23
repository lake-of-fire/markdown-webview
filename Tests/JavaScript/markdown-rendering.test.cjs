const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const resources = path.join(__dirname, '../../Sources/MarkdownWebView/Resources')
const bundledScript = fs.readFileSync(path.join(resources, 'script'), 'utf8')
const template = fs.readFileSync(path.join(resources, 'template'), 'utf8')

function loadRenderer({ codeBlock } = {}) {
  const renderedElement = { innerHTML: '' }
  const renderedMessages = []
  const copyMessages = []
  const timers = []
  const assets = []
  const assetRequestSnapshots = []
  const context = vm.createContext({
    document: {
      getElementById: () => renderedElement,
      querySelectorAll: selector => selector === 'pre' && codeBlock ? [codeBlock] : [],
      createElement(tagName) {
        const classes = new Set()
        return Object.assign(new EventTarget(), {
          tagName,
          classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
          children: [],
          appendChild(child) { this.children.push(child) }
        })
      },
      head: {
        appendChild(asset) {
          assets.push(asset)
          assetRequestSnapshots.push({ html: renderedElement.innerHTML, renderedCount: renderedMessages.length })
        }
      }
    },
    ResizeObserver: class {
      observe() {}
    },
    setTimeout: callback => timers.push(callback),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    webkit: {
      messageHandlers: {
        renderedContentHandler: { postMessage: value => renderedMessages.push(value) },
        sizeChangeHandler: { postMessage() {} },
        copyToPasteboard: { postMessage: value => copyMessages.push(value) }
      }
    }
  })
  context.window = context
  context.self = context
  vm.runInContext(bundledScript, context, { filename: 'Resources/script' })
  for (const match of template.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim() === 'PLACEHOLDER_SCRIPT') continue
    vm.runInContext(match[1], context, { filename: 'Resources/template' })
  }

  function dispatchAssetEvent(path, type) {
    const asset = assets.find(candidate => (candidate.src ?? candidate.href)?.endsWith(path))
    assert.ok(asset, `No pending asset request for ${path}`)
    asset.dispatchEvent(new Event(type))
    return asset
  }

  return {
    render(markdown) {
      context.updateWithMarkdownContentBase64Encoded(encode(markdown))
      return renderedElement.innerHTML
    },
    finishScript(path, globals = {}) {
      Object.assign(context, globals)
      dispatchAssetEvent(path, 'load')
    },
    finishStylesheet(path) {
      assert.equal(dispatchAssetEvent(path, 'load').media, 'all')
    },
    failAsset(path) { dispatchAssetEvent(path, 'error') },
    finishCopyFeedback() { timers.shift()?.() },
    get html() { return renderedElement.innerHTML },
    assets,
    assetRequestSnapshots,
    renderedMessages,
    copyMessages
  }
}

function encode(markdown) {
  return Buffer.from(markdown, 'utf8').toString('base64')
}

test('ordinary Markdown is rendered and acknowledged before requesting optional math', () => {
  const renderer = loadRenderer()
  assert.equal(renderer.assets.length, 0)
  const markdown = '# 日本語 📚\n\nA **saved** note with [a link](https://example.com/).'
  const html = renderer.render(markdown)
  assert.match(html, /<h1>日本語 📚<\/h1>/)
  assert.match(html, /<strong>saved<\/strong>/)
  assert.match(html, /<a href="https:\/\/example.com\/">a link<\/a>/)
  assert.deepEqual(renderer.renderedMessages, [encode(markdown)])
  assert.equal(renderer.assets.length, 3)
  assert.deepEqual(renderer.assets.slice(0, 2).map(asset => asset.media), ['print', 'print'])
  for (const snapshot of renderer.assetRequestSnapshots) {
    assert.equal(snapshot.html, html)
    assert.equal(snapshot.renderedCount, 1)
  }
  assert.match(renderer.assets[2].src, /\/katex@0\.16\.10\/dist\/katex\.min\.js$/)
})

test('a failed math plugin does not prevent later ordinary updates', () => {
  const renderer = loadRenderer()
  assert.match(renderer.render('First paragraph'), /<p>First paragraph<\/p>/)
  renderer.finishScript('katex.min.js', { katex: { renderToString() {} } })
  assert.match(renderer.assets[3].src, /\/markdown-it-texmath@1\.0\.0\/texmath\.min\.js$/)
  renderer.failAsset('texmath.min.js')
  assert.match(renderer.render('Updated **paragraph**'), /<strong>paragraph<\/strong>/)
  assert.equal(renderer.assets.length, 4)
  assert.deepEqual(renderer.renderedMessages, [encode('First paragraph'), encode('Updated **paragraph**')])
})

test('a missing KaTeX engine leaves math text readable without installing its plugin', () => {
  let pluginCalls = 0
  const renderer = loadRenderer()
  renderer.render('The expression is $x + y$.')
  renderer.finishStylesheet('katex.min.css')
  renderer.finishStylesheet('texmath.min.css')
  renderer.finishScript('katex.min.js')
  renderer.finishScript('texmath.min.js', { texmath() { pluginCalls++ } })
  assert.equal(pluginCalls, 0)
  assert.match(renderer.html, /The expression is \$x \+ y\$\./)
})

test('late math support rerenders the latest Markdown without acknowledging it twice', () => {
  const katex = { renderToString() {} }
  const installations = []
  const renderer = loadRenderer()
  assert.match(renderer.render('Initial text'), /<p>Initial text<\/p>/)
  renderer.finishScript('katex.min.js', { katex })
  assert.match(renderer.render('Latest **Markdown**'), /<strong>Markdown<\/strong>/)
  renderer.finishScript('texmath.min.js', {
    texmath(markdownIt, options) {
      installations.push(options)
      markdownIt.core.ruler.before('inline', 'math-plugin-control', state => {
        state.tokens.find(token => token.type === 'inline').content += ' plugin-enabled'
      })
    }
  })
  assert.equal(installations.length, 0)
  assert.match(renderer.html, /Latest <strong>Markdown<\/strong><\/p>/)
  renderer.finishStylesheet('texmath.min.css')
  assert.equal(installations.length, 0)
  renderer.finishStylesheet('katex.min.css')
  assert.equal(installations.length, 1)
  assert.equal(installations[0].engine, katex)
  assert.equal(installations[0].katexOptions.throwOnError, false)
  assert.ok(installations[0].delimiters.includes('dollars'))
  assert.match(renderer.html, /Latest <strong>Markdown<\/strong> plugin-enabled/)
  assert.deepEqual(renderer.renderedMessages, [encode('Initial text'), encode('Latest **Markdown**')])
  assert.match(renderer.render('Another update'), /Another update plugin-enabled/)
  assert.equal(renderer.assets.length, 4)
})

test('stylesheets can finish before either script without installing partial math support', () => {
  const renderer = loadRenderer()
  let installations = 0
  renderer.render('The expression is $x$.')
  renderer.finishStylesheet('texmath.min.css')
  renderer.finishStylesheet('katex.min.css')
  assert.equal(renderer.assets.length, 3)
  renderer.finishScript('katex.min.js', { katex: { renderToString() {} } })
  assert.equal(installations, 0)
  renderer.finishScript('texmath.min.js', { texmath() { installations++ } })
  assert.equal(installations, 1)
})

test('a stylesheet failure leaves readable math source despite successful scripts', () => {
  const renderer = loadRenderer()
  let installations = 0
  renderer.render('The expression is $x$.')
  renderer.finishStylesheet('katex.min.css')
  renderer.failAsset('texmath.min.css')
  renderer.finishScript('katex.min.js', { katex: { renderToString() {} } })
  renderer.finishScript('texmath.min.js', { texmath() { installations++ } })
  assert.equal(installations, 0)
  assert.match(renderer.render('Another expression is $y$.'), /Another expression is \$y\$\./)
  assert.deepEqual(renderer.renderedMessages, [encode('The expression is $x$.'), encode('Another expression is $y$.')])
})

test('an optional plugin that throws during installation leaves ordinary rendering intact', () => {
  const renderer = loadRenderer()
  renderer.render('Before math')
  renderer.finishStylesheet('katex.min.css')
  renderer.finishStylesheet('texmath.min.css')
  renderer.finishScript('katex.min.js', { katex: { renderToString() {} } })
  renderer.finishScript('texmath.min.js', {
    texmath(markdownIt) {
      markdownIt.core.ruler.push('incomplete-math-plugin', () => { throw new Error('Incomplete installation') })
      throw new Error('Math installation failed')
    }
  })
  assert.match(renderer.html, /<p>Before math<\/p>/)
  assert.match(renderer.render('After math failed'), /<p>After math failed<\/p>/)
})

test('a later math render failure falls back for that update and acknowledges its source', () => {
  const renderer = loadRenderer()
  renderer.render('Before math')
  renderer.finishStylesheet('katex.min.css')
  renderer.finishStylesheet('texmath.min.css')
  renderer.finishScript('katex.min.js', { katex: { renderToString() {} } })
  renderer.finishScript('texmath.min.js', {
    texmath(markdownIt) {
      markdownIt.core.ruler.before('inline', 'math-render-failure', state => {
        if (state.src === 'Unsupported math') throw new Error('Math rendering failed')
        state.tokens.find(token => token.type === 'inline').content += ' with math'
      })
    }
  })
  assert.match(renderer.html, /<p>Before math with math<\/p>/)
  assert.match(renderer.render('Unsupported math'), /<p>Unsupported math<\/p>/)
  assert.match(renderer.render('Next update'), /<p>Next update with math<\/p>/)
  assert.deepEqual(renderer.renderedMessages, [
    encode('Before math'), encode('Unsupported math'), encode('Next update')
  ])
})

test('copy controls have a local label and preserve code whitespace while assets are pending', () => {
  const wrappers = []
  const code = 'first line\n  second line\n'
  const renderer = loadRenderer({
    codeBlock: {
      innerText: code,
      parentNode: { insertBefore: wrapper => wrappers.push(wrapper) }
    }
  })
  renderer.render('~~~\n' + code + '~~~')
  const button = wrappers[0].children[1]
  assert.equal(button.textContent, 'Copy')
  button.dispatchEvent(new Event('click'))
  assert.equal(button.textContent, 'Copied')
  assert.deepEqual(renderer.copyMessages, [code])
  renderer.finishStylesheet('katex.min.css')
  renderer.finishStylesheet('texmath.min.css')
  renderer.finishScript('katex.min.js', { katex: { renderToString() {} } })
  renderer.finishScript('texmath.min.js', { texmath() {} })
  assert.equal(wrappers.length, 1)
  assert.equal(button.textContent, 'Copied')
  renderer.finishCopyFeedback()
  assert.equal(button.textContent, 'Copy')
})
