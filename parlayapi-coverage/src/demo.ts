import { checkCoverage } from "./coverage.js";

console.log(JSON.stringify(await checkCoverage({ mode: "demo" }), null, 2));
