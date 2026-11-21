// panel-scenario.mjs whose session/load replays the history and then answers with an error (the failure-path check).
import panel from "./panel-scenario.mjs";

export default { ...panel, load: { error: "scripted load failure" } };
