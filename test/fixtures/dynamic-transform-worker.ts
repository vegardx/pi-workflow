import { parentPort, workerData } from "node:worker_threads";
import { transformDynamicSource } from "../../src/dynamic/transformer.js";

const input = workerData as { source: string; filename: string };
parentPort?.postMessage(transformDynamicSource(input).code);
