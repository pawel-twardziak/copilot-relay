// Exposes a narrow API to the sandboxed renderer.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const on = (channel) => (fn) => {
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("api", {
  listSessions: () => call("sessions:list"),
  newSession: (cwd) => call("sessions:new", cwd),
  openSession: (sessionId, cwd) => call("sessions:open", sessionId, cwd),
  // source: "app" (typed here), "human" (relay web GUI) or "relay" (another session) – see sessions:prompt
  prompt: (sessionId, text, source = "relay") => call("sessions:prompt", sessionId, text, source),
  relayRename: (sessionId, name) => call("relay:rename", sessionId, name),
  // the Copilot session's title (Copilot's /rename), not the relay name
  renameSession: (sessionId, name) => call("sessions:rename", sessionId, name),
  // number of user messages recorded in the Copilot session history
  userMessages: (sessionId) => call("sessions:userMessages", sessionId),
  cancel: (sessionId) => call("sessions:cancel", sessionId),
  closeSession: (sessionId) => call("sessions:close", sessionId),
  // target: { ordinal, text, where } – the message to cut at, see electron/history.mjs
  countFrom: (sessionId, target) => call("sessions:countFrom", sessionId, target),
  forkSession: (sessionId, target) => call("sessions:fork", sessionId, target),
  truncateSession: (sessionId, target) => call("sessions:truncate", sessionId, target),
  // removes the whole session from disk (closes it first)
  deleteSession: (sessionId) => call("sessions:delete", sessionId),
  setConfig: (sessionId, configId, value) => call("sessions:setConfig", sessionId, configId, value),
  answerPermission: (sessionId, reqId, optionId) => call("permission:answer", sessionId, reqId, optionId),
  // a delivered report or notice has started its prompt: the broker may forget it
  relayAck: (sessionId, id) => call("relay:ack", sessionId, id),
  answerDelegation: (requestId, approved) => call("delegation:answer", requestId, approved),
  stopChildren: (parentSessionId) => call("delegation:stopChildren", parentSessionId),
  pickDir: () => call("dialog:pickDir"),
  getSettings: () => call("settings:get"),
  setSettings: (s) => call("settings:set", s),
  openPath: (p) => call("shell:openPath", p),
  copy: (text) => call("clipboard:write", text),
  openLink: (cwd, target) => call("open:link", cwd, target),
  // which of the mentioned paths (relative to base, or null) are existing files
  checkFiles: (base, candidates) => call("files:check", base, candidates),
  // text of a clicked file link: { notText } | { outside, path } until confirmed | { path, name, text?, tier, size, mtimeMs }
  readFile: (baseCwd, target, opts) => call("files:read", baseCwd, target, opts),
  storage: () => call("storage:get"),
  openPastes: () => call("storage:openPastes"),
  clearPastes: () => call("storage:clearPastes"),
  imageConfig: () => call("images:config"),
  // a chat image as a data: URL; { outside } for a local file outside the session/paste folders unless clicked
  loadImage: (cwd, src, opts) => call("images:load", cwd, src, opts),
  savePastedImage: (bytes, mime) => call("paste:saveImage", bytes, mime),
  // real path of a File from paste / drag & drop ("" for in-memory data such as a copied screenshot)
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  onUpdate: on("acp:update"),
  onPermission: on("acp:permission"),
  onExit: on("acp:exit"),
  onUsage: on("usage:update"),
  onNotice: on("acp:notice"),
  onRelayMessage: on("relay:message"),
  onRelayStatus: on("relay:status"),
  onDelegationRequest: on("delegation:request"),
  onDelegationCreated: on("delegation:created"),
  onDelegationClosed: on("delegation:closed"),
});
