// Exposes a narrow API to the sandboxed renderer.
const { contextBridge, ipcRenderer } = require("electron");

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
  prompt: (sessionId, text, human = true) => call("sessions:prompt", sessionId, text, human),
  relayRename: (sessionId, name) => call("relay:rename", sessionId, name),
  cancel: (sessionId) => call("sessions:cancel", sessionId),
  closeSession: (sessionId) => call("sessions:close", sessionId),
  setConfig: (sessionId, configId, value) => call("sessions:setConfig", sessionId, configId, value),
  answerPermission: (sessionId, reqId, optionId) => call("permission:answer", sessionId, reqId, optionId),
  pickDir: () => call("dialog:pickDir"),
  getSettings: () => call("settings:get"),
  setSettings: (s) => call("settings:set", s),
  openPath: (p) => call("shell:openPath", p),
  copy: (text) => call("clipboard:write", text),
  onUpdate: on("acp:update"),
  onPermission: on("acp:permission"),
  onExit: on("acp:exit"),
  onRelayMessage: on("relay:message"),
  onRelayStatus: on("relay:status"),
});
