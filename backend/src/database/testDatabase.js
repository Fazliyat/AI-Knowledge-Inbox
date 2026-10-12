import db from "./database.js";

const itemsTable = db
    .prepare("PRAGMA table_info(items)")
    .all();

const chunksTable = db
    .prepare("PRAGMA table_info(chunks)")
    .all();

console.log("Items table columns:");
console.log(itemsTable.map((column) => column.name));

console.log("Chunks table columns:");
console.log(chunksTable.map((column) => column.name));

db.close();