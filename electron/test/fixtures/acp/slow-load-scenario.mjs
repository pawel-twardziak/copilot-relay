// panel-scenario.mjs whose session/load answers 1.5 s after its replay (the close-while-resuming check).
import panel from "./panel-scenario.mjs";

export default { ...panel, load: { delay: 1500 } };
