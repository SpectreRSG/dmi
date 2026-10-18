// Talks to the database (Postgres, hosted by Netlify Database).
//
// Other files use it like:
//   const db = require('./db');
//   const staff = await db.all('SELECT * FROM employees WHERE status = ?', 'active');
//   const one = await db.get('SELECT * FROM employees WHERE id = ?', id);
//   const id = await db.insert('INSERT INTO clients (name) VALUES (?)', name);
//   await db.run('UPDATE clients SET name = @name WHERE id = @id', { name, id });
//   await db.transaction(async (tx) => { ...use tx instead of db... });
//
// "await" means "wait for the database to answer", because it's on another computer.
const { getDatabase } = require('@netlify/database');
const config = require('./config');

let database = null;
function pool() {
  if (!database) {
    database = config.databaseUrl ? getDatabase({ connectionString: config.databaseUrl }) : getDatabase();
  }
  return database.pool;
}

// We write SQL with ? (or @name) where a value goes. Postgres wants $1, $2…
// Values are always sent separately from the SQL, which prevents SQL injection.
function toPostgres(sql, params) {
  const named = params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0]);
  const values = [];
  const nameIndex = new Map();
  let text = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") inString = !inString; // skip anything inside 'quotes'
    if (!inString && !named && ch === '?') {
      values.push(params[values.length]);
      text += `$${values.length}`;
    } else if (!inString && named && ch === '@' && /[a-z_]/i.test(sql[i + 1] || '')) {
      const name = /^[a-z_][a-z0-9_]*/i.exec(sql.slice(i + 1))[0];
      if (!(name in params[0])) throw new Error(`No value given for @${name}`);
      if (!nameIndex.has(name)) {
        values.push(params[0][name]);
        nameIndex.set(name, values.length);
      }
      text += `$${nameIndex.get(name)}`;
      i += name.length;
    } else {
      text += ch;
    }
  }
  if (!named && values.length !== params.length) {
    throw new Error(`SQL expects ${values.length} values but got ${params.length}`);
  }
  return { text, values };
}

function makeApi(query) {
  const run = (sql, params) => {
    const { text, values } = toPostgres(sql, params);
    return query(text, values);
  };
  return {
    // Every matching row, as a list.
    all: async (sql, ...params) => (await run(sql, params)).rows,
    // The first matching row (or undefined).
    get: async (sql, ...params) => (await run(sql, params)).rows[0],
    // Change rows; tells you how many changed.
    run: async (sql, ...params) => ({ changes: (await run(sql, params)).rowCount }),
    // Add a row; gives back its new id.
    insert: async (sql, ...params) => (await run(`${sql} RETURNING id`, params)).rows[0].id,
  };
}

const db = makeApi((text, values) => pool().query(text, values));

// Runs several changes as one: either they all happen, or (if anything fails) none do.
db.transaction = async (work) => {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(makeApi((text, values) => client.query(text, values)));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

db.close = async () => {
  if (database) await database.pool.end();
  database = null;
};

module.exports = db;
module.exports.toPostgres = toPostgres;
