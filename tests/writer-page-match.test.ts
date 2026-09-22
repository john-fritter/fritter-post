import assert from "node:assert/strict";
import { pageMatchesTitle } from "../src/pipeline/writers/assembler.js";

// Sep 8, rank 2: a La Nación item titled as live Ukraine war coverage whose
// link went to a real-estate story. Shape reconstructed; the failure is that
// the page shares none of the headline's distinctive words.
assert.equal(
  pageMatchesTitle(
    "Guerra en Ucrania, en vivo: Rusia reanudó los bombardeos sobre Kiev tras la pausa",
    "Cuánto cuesta alquilar un departamento en Buenos Aires. Los precios de los alquileres " +
      "subieron otra vez este mes y la canasta básica alimentaria también aumentó. " +
      "Comparamos los valores de los barrios porteños con los del conurbano.",
  ),
  false,
);

// The real article repeats its headline's words, accents and case aside.
assert.equal(
  pageMatchesTitle(
    "Guerra en Ucrania: Rusia reanudó los bombardeos sobre Kiev",
    "Rusia reanudó este lunes los bombardeos sobre Kiev después de una pausa de tres días. " +
      "La guerra en Ucrania entra en una nueva fase, según funcionarios.",
  ),
  true,
);
assert.equal(
  pageMatchesTitle(
    "Jaguar Land Rover will cut 4,000 jobs over two years",
    "The carmaker JAGUAR Land Rover said it would shed staff at its head office.",
  ),
  true,
);

// A page that repeats only some of a long headline still passes: the floor is
// for a different article, not a loosely worded one. Two of seven words here.
assert.equal(
  pageMatchesTitle(
    "Houthis seize Yemen's Red Sea port of Mocha, advancing toward Bab el-Mandeb Strait",
    "Fighters took control of Mocha on Tuesday after days of shelling, and the " +
      "Houthis now hold the coast south of Hodeidah.",
  ),
  true,
);

// ...and one of seven is a different article.
assert.equal(
  pageMatchesTitle(
    "Houthis seize Yemen's Red Sea port of Mocha, advancing toward Bab el-Mandeb Strait",
    "A new coffee shop called Mocha opened downtown on Tuesday.",
  ),
  false,
);

// Too few distinctive words to judge: never refused.
assert.equal(pageMatchesTitle("Fed cuts rates", "Unrelated text about gardening."), true);

console.log("writer page-match tests passed");
