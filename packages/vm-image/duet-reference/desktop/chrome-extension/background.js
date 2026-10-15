const socketUrl = 'ws://127.0.0.1:3000/v1/desktop/browser-extension/socket'
const workerStartedAt = Date.now()
let socket
let keepalive
let reconnect
let focusTimer

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function emit(event, fields) {
  send({ type: 'event', event, ...fields, at: Date.now() })
}

async function targets() {
  return chrome.debugger.getTargets()
}

async function snapshot() {
  const [windows, tabs, allTargets] = await Promise.all([
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    chrome.tabs.query({}),
    targets(),
  ])
  return {
    windows: windows.map(window => ({
      windowId: window.id,
      focused: window.focused,
      state: window.state,
      tabs: tabs
        .filter(tab => tab.windowId === window.id)
        .map(tab => ({
          tabId: tab.id,
          windowId: tab.windowId,
          url: tab.url,
          title: tab.title,
          active: tab.active,
          discarded: Boolean(tab.discarded),
          targetId: allTargets.find(target => target.tabId === tab.id && target.type === 'page')
            ?.id,
        })),
    })),
  }
}

async function waitForTarget(tabId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = (await targets()).find(
      candidate => candidate.tabId === tabId && candidate.type === 'page',
    )
    if (target) return target.id
    await delay(50)
  }
  throw new Error('exact tab target did not appear')
}

async function command(message) {
  switch (message.command) {
    case 'snapshot':
      return snapshot()
    case 'createWindow': {
      const window = await chrome.windows.create({ url: message.url, focused: false })
      const [tab] = await chrome.tabs.query({ windowId: window.id })
      if (!tab) throw new Error('new window did not contain a tab')
      return { windowId: window.id, tabId: tab.id, targetId: await waitForTarget(tab.id) }
    }
    case 'createTab': {
      const tab = await chrome.tabs.create({
        windowId: message.windowId,
        url: message.url,
        active: message.active,
      })
      return { tabId: tab.id, windowId: tab.windowId, targetId: await waitForTarget(tab.id) }
    }
    case 'activateTab': {
      const tab = await chrome.tabs.update(message.tabId, { active: true })
      return { tabId: tab.id, windowId: tab.windowId, targetId: await waitForTarget(tab.id) }
    }
    case 'moveTab': {
      const tab = await chrome.tabs.move(message.tabId, {
        windowId: message.windowId,
        index: -1,
      })
      return { tabId: tab.id, windowId: tab.windowId, targetId: await waitForTarget(tab.id) }
    }
    case 'focusWindow': {
      await chrome.windows.update(message.windowId, { state: 'normal' })
      if (message.tabId !== undefined) await chrome.tabs.update(message.tabId, { active: true })
      await chrome.windows.update(message.windowId, { focused: true })
      return { windowId: message.windowId }
    }
    case 'closeWindow':
      await chrome.windows.remove(message.windowId)
      return { windowId: message.windowId }
    case 'closeTab':
      await chrome.tabs.remove(message.tabId)
      return { tabId: message.tabId }
    case 'discardTab': {
      const tab = await chrome.tabs.discard(message.tabId)
      return {
        removedTabId: message.tabId,
        replacementTabId: tab.id,
        windowId: tab.windowId,
        targetId: await waitForTarget(tab.id),
        discarded: Boolean(tab.discarded),
      }
    }
    default:
      throw new Error('unknown browser extension command')
  }
}

function connect() {
  if (socket && socket.readyState < WebSocket.CLOSING) return
  clearTimeout(reconnect)
  socket = new WebSocket(socketUrl)
  socket.onopen = () => {
    send({ type: 'hello', extensionId: chrome.runtime.id, workerStartedAt })
    clearInterval(keepalive)
    keepalive = setInterval(() => send({ type: 'keepalive', at: Date.now() }), 20_000)
  }
  socket.onmessage = async event => {
    const message = JSON.parse(event.data)
    try {
      send({ type: 'response', requestId: message.requestId, result: await command(message) })
    } catch (error) {
      send({ type: 'response', requestId: message.requestId, error: String(error) })
    }
  }
  socket.onclose = () => {
    clearInterval(keepalive)
    reconnect = setTimeout(connect, 1_000)
  }
}

chrome.windows.onFocusChanged.addListener(windowId => {
  clearTimeout(focusTimer)
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    emit('focusTransient', { windowId })
    focusTimer = setTimeout(async () => {
      const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
      emit('focusSettled', { windowId: focused.id })
    }, 250)
    return
  }
  emit('focusSettled', { windowId })
})
chrome.windows.onRemoved.addListener(windowId => emit('windowRemoved', { windowId }))
chrome.tabs.onCreated.addListener(tab =>
  emit('tabCreated', { tabId: tab.id, windowId: tab.windowId }),
)
chrome.tabs.onActivated.addListener(({ tabId, windowId }) =>
  emit('tabActivated', { tabId, windowId }),
)
chrome.tabs.onRemoved.addListener((tabId, { windowId }) => emit('tabRemoved', { tabId, windowId }))
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) =>
  emit('tabReplaced', { addedTabId, removedTabId }),
)

connect()
