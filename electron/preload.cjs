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
  // { sessions, complete }: complete is false when Copilot had more pages than main fetches
  listSessionsChecked: () => call("sessions:listChecked"),
  // own: the session's own part of its system prompt (see electron/session-prompts.mjs)
  newSession: (cwd, own = "") => call("sessions:new", cwd, own),
  openSession: (sessionId, cwd, replayId) => call("sessions:open", sessionId, cwd, replayId),
  // source: "app" (typed here), "human" (relay web GUI) or "relay" (another session) – see sessions:prompt
  prompt: (sessionId, text, source = "relay") => call("sessions:prompt", sessionId, text, source),
  relayRename: (sessionId, name) => call("relay:rename", sessionId, name),
  // the Copilot session's title (Copilot's /rename), not the relay name
  renameSession: (sessionId, name) => call("sessions:rename", sessionId, name),
  // number of user messages recorded in the Copilot session history
  userMessages: (sessionId) => call("sessions:userMessages", sessionId),
  // times (ms) of the recorded messages: { users: in order, agents: by messageId }, see electron/history.mjs
  messageTimes: (sessionId) => call("sessions:messageTimes", sessionId),
  cancel: (sessionId) => call("sessions:cancel", sessionId),
  closeSession: (sessionId) => call("sessions:close", sessionId),
  // target: { ordinal, text, where } – the message to cut at, see electron/history.mjs
  countFrom: (sessionId, target) => call("sessions:countFrom", sessionId, target),
  forkSession: (sessionId, target) => call("sessions:fork", sessionId, target),
  truncateSession: (sessionId, target) => call("sessions:truncate", sessionId, target),
  // removes the whole session from disk (closes it first)
  deleteSession: (sessionId) => call("sessions:delete", sessionId),
  setConfig: (sessionId, configId, value) => call("sessions:setConfig", sessionId, configId, value),
  // closes the session for a restart with the new context window; the caller reopens it
  setContextTier: (sessionId, value) => call("sessions:setContextTier", sessionId, value),
  // { own, defaultPart, childPart, isChild }: the parts of the session's prompt
  getPrompt: (sessionId) => call("sessions:getPrompt", sessionId),
  // a new own part: { refused } | { unchanged: true } | { reopen: true } (closed for the restart; the caller reopens it)
  setPrompt: (sessionId, own) => call("sessions:setPrompt", sessionId, own),
  answerPermission: (sessionId, reqId, optionId) => call("permission:answer", sessionId, reqId, optionId),
  // a delivered report or notice has started its prompt: the broker may forget it
  relayAck: (sessionId, id) => call("relay:ack", sessionId, id),
  answerDelegation: (requestId, approved, own) => call("delegation:answer", requestId, approved, own),
  // the broker's sub-session links ({ key: "cli:<id>", parent, name, task, createdAt, reported, parentDeleted, online,
  // busy }): the cached snapshot at once, the fresh one follows through onLinks
  getLinks: () => call("links:get"),
  // the per-session approval switch for replies from sub-sessions
  getHoldReplies: (sessionId) => call("held:get", sessionId),
  setHoldReplies: (sessionId, on) => call("held:set", sessionId, on),
  // keys are "cli:<sessionId>": removed from the tree by the user / no longer in Copilot's session list
  forgetLinks: (keys) => call("links:forget", keys),
  reportMissing: (keys) => call("links:missing", keys),
  // the user's answer to a reopen card; reason "missing" when the target session no longer exists
  answerReopen: (sessionId, requestId, approved, reason) => call("reopen:answer", sessionId, requestId, approved, reason),
  // the user's answer to a link card (adopt_session, release_session): { result, text }, or false when no longer pending
  answerLink: (sessionId, requestId, approved) => call("link:answer", sessionId, requestId, approved),
  pickDir: (title) => call("dialog:pickDir", title),
  // the Settings "Relay broker" section: status = the restart snapshot + working sessions + broker-web sessions
  brokerStatus: () => call("broker:status"),
  brokerRestart: (repo) => call("broker:restart", repo),
  onBrokerRestart: on("broker:restart"),
  getSettings: () => call("settings:get"),
  setSettings: (s) => call("settings:set", s),
  openPath: (p) => call("shell:openPath", p),
  copy: (text) => call("clipboard:write", text),
  openLink: (cwd, target) => call("open:link", cwd, target),
  // which of the mentioned paths (relative to base, or null) are existing files
  checkFiles: (base, candidates) => call("files:check", base, candidates),
  // text of a clicked file link: { notText } | { outside, path } until confirmed | { path, name, text?, tier, size, mtimeMs }
  readFile: (baseCwd, target, opts) => call("files:read", baseCwd, target, opts),
  // watch the file on show (a path files:read returned; null stops); onFileChanged gets the changed path
  watchFile: (p) => call("files:watch", p),
  onFileChanged: on("files:changed"),
  // the changes browser (electron/repo-changes.mjs): { repos, loose, opened } of a session, a file's commits since the
  // start point, one diff (version "uncommitted" or a commit sha), adding a repository by a folder dialog (null when
  // cancelled, else { root } or { message }) and removing one; changesOpened records a file opened from a link (its
  // real path), changesForgetOpened takes it off the list
  changesList: (sessionId) => call("changes:list", sessionId),
  changesCommits: (sessionId, root, rel) => call("changes:commits", sessionId, root, rel),
  changesDiff: (sessionId, root, rel, version) => call("changes:diff", sessionId, root, rel, version),
  changesAdd: (sessionId) => call("changes:add", sessionId),
  changesRemove: (sessionId, root) => call("changes:remove", sessionId, root),
  changesOpened: (sessionId, p) => call("changes:opened", sessionId, p),
  changesForgetOpened: (sessionId, p) => call("changes:forget-opened", sessionId, p),
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
  jobsList: () => call("jobs:list"),
  jobsSave: (input) => call("jobs:save", input),
  jobsDelete: (id) => call("jobs:delete", id),
  jobsSetEnabled: (id, on) => call("jobs:setEnabled", id, on),
  jobsRunNow: (id) => call("jobs:runNow", id),
  jobsRuns: (jobId) => call("jobs:runs", jobId),
  jobsRun: (jobId, runId) => call("jobs:run", jobId, runId),
  jobsPreview: (expr) => call("jobs:previewSchedule", expr),
  onJobsChanged: on("jobs:changed"),
  onJobRunFinished: on("jobs:runFinished"),
  onJobOpenRun: on("jobs:openRun"),
  onUpdate: on("acp:update"),
  onReplayed: on("acp:replayed"),
  onPermission: on("acp:permission"),
  onExit: on("acp:exit"),
  onUsage: on("usage:update"),
  onNotice: on("acp:notice"),
  onRelayMessage: on("relay:message"),
  onRelayStatus: on("relay:status"),
  onDelegationRequest: on("delegation:request"),
  onDelegationCreated: on("delegation:created"),
  onDelegationClosed: on("delegation:closed"),
  onLinks: on("links:update"),
  // { sessionId (the sender), requestId, targetSessionId, targetName, fromName, previews }
  onReopenRequest: on("reopen:request"),
  // { sessionId (the parent that asked), requestId, kind ("adopt" | "release"), childSessionId, childName, childCwd, parentName, task }
  onLinkRequest: on("link:request"),
});
