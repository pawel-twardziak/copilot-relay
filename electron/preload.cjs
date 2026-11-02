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
  cancel: (sessionId) => call("sessions:cancel", sessionId),
  closeSession: (sessionId) => call("sessions:close", sessionId),
  // target: { ordinal, text, where } – the message to cut at, see electron/history.mjs
  countFrom: (sessionId, target) => call("sessions:countFrom", sessionId, target),
  forkSession: (sessionId, target) => call("sessions:fork", sessionId, target),
  truncateSession: (sessionId, target) => call("sessions:truncate", sessionId, target),
  setConfig: (sessionId, configId, value) => call("sessions:setConfig", sessionId, configId, value),
  answerPermission: (sessionId, reqId, optionId) => call("permission:answer", sessionId, reqId, optionId),
  pickDir: () => call("dialog:pickDir"),
  getSettings: () => call("settings:get"),
  setSettings: (s) => call("settings:set", s),
  openPath: (p) => call("shell:openPath", p),
  copy: (text) => call("clipboard:write", text),
  openLink: (cwd, target) => call("open:link", cwd, target),
  storage: () => call("storage:get"),
  openPastes: () => call("storage:openPastes"),
  clearPastes: () => call("storage:clearPastes"),
  imageConfig: () => call("images:config"),
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
  onNotice: on("acp:notice"),
  onRelayMessage: on("relay:message"),
  onRelayStatus: on("relay:status"),
});
