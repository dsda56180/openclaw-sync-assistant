const assert = require("assert");
const plugin = require("./index.js");

try {
  assert.ok(plugin !== undefined, "Plugin module should be exported properly");
  console.log("✅ Test passed: Plugin loads successfully.");
} catch (error) {
  console.error("❌ Test failed:", error.message);
  process.exit(1);
}
