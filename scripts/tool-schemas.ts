import { getToolSpecs } from "../src/tools/index.js";

/**
 * Prints every tool definition exactly as the model receives it (name, description, JSON Schema).
 * Usage: npm run tools:schema
 */
console.log(JSON.stringify(getToolSpecs(), null, 2));
