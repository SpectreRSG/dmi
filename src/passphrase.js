// Passphrases for the public schedule portal, like "maple-falcon-river-27".
// Easy to read out over the phone, hard to guess (about a billion
// combinations, and wrong guesses are rate-limited).
//
// We never store the passphrase itself, only a keyed fingerprint (HMAC) of it,
// so nobody reading the database can see or reuse it.
const crypto = require('crypto');
const { storedSecret } = require('./secrets');

// 256 short, everyday words that are hard to mishear or misspell.
const WORDS = `
acorn actor adobe agent alarm album alpine amber anchor angle apple apron arrow aspen atlas autumn
badge bagel baker bamboo banjo barley basin beacon beaver berry bison blade blanket blaze bloom bluff
bonus border boulder bracket branch brave breeze brick bridge brook bucket buffalo bugle bunny butter cabin
cactus camel camera candle canoe canyon carbon cargo carpet castle cedar cello chalk channel cherry chess
cider cinema circus citrus clover cobalt coconut comet copper coral cotton cougar coyote crane crayon cricket
crown crystal cupcake dahlia daisy delta denim desert diamond dinner dolphin donut dragon drum eagle ember
engine falcon feather fern fiddle field fig flame flint forest fossil fountain fox galaxy garden garnet
gecko geyser ginger glacier globe goose granite grape gravel guitar harbor harvest hazel helmet heron
hickory honey horizon hornet iceberg igloo indigo island ivory jacket jaguar jasmine jelly jungle kayak kettle
kiwi koala ladder lagoon lantern lemon lily lion lizard lobster locket lotus magnet mango maple marble meadow
melon meteor mint mitten monkey moose mosaic muffin nectar needle nickel noodle nutmeg oasis ocean olive
onion opal orange orbit orchid otter oyster paddle panda panther papaya parrot pasta peach pearl pebble
pecan pelican pepper piano pickle pigeon pillow pilot pine planet plum pocket polar pony poppy prairie
pretzel puffin pumpkin quartz quill rabbit radar raven reef ribbon river robin rocket ruby saddle salmon
sapphire scarf shadow shell sierra silver sketch sparrow spruce squash stable summit sunset swan tango
teapot thistle thunder tiger timber toast topaz tractor trumpet tulip tundra turtle valley velvet violet walnut willow
`.trim().split(/\s+/);

function pick(list) {
  return list[crypto.randomInt(list.length)];
}

function makePassphrase() {
  return `${pick(WORDS)}-${pick(WORDS)}-${pick(WORDS)}-${crypto.randomInt(10, 100)}`;
}

// Forgiving about how it's typed: "Maple Falcon river 27" works too.
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

async function fingerprint(passphrase) {
  const key = await storedSecret('portal_key', () => crypto.randomBytes(32).toString('hex'));
  return crypto.createHmac('sha256', key).update(normalize(passphrase)).digest('hex');
}

module.exports = { WORDS, makePassphrase, normalize, fingerprint };
