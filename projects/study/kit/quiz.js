/* Study-project test engine. Shared by every deck: a loop writes only bank.js (its questions), never this file.
   bank.js sets globalThis.QUIZ = { meta: {...}, bank: [...] } and must load before this file.
   Every question shows exactly two answers, and every question comes from one slide.
   Item fields (all items): id, type, slide (1-based slide number), anchor (words copied from that slide), explain.
     pick : prompts[] (2+ wordings), answer (or answers[]: wordings of the right answer), wrongs[] (2+, one shown)
     tf   : trues[], falses[] (statements; one shown, answered True or False; 3+ in all, at least one of each)
   Randomized on every attempt: which items, their order, each item's wording and which wrong answer appears.
   A round: a missed question comes back later in the same round, reworded, until it is answered right. */
(function (root) {
  "use strict";

  const GAP = 2; // a missed question returns after this many others (sooner if the round is nearly over)

  function shuffle(arr, rnd) { // Fisher-Yates, in place
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];
  const sample = (arr, n, rnd) => shuffle(arr.slice(), rnd).slice(0, n);
  const other = (arr, not, rnd) => { const rest = arr.filter((x) => x !== not); return pick(rest.length ? rest : arr, rnd); };

  // One rendering of an item. `prev` is an earlier rendering to move away from (a retry): new wording, new wrong answer.
  function build(item, rnd, prev) {
    const base = { id: item.id, kind: item.type, slide: item.slide, explain: item.explain };
    if (item.type === "pick") {
      const answers = item.answers || [item.answer];
      const answer = prev ? other(answers, prev.answerText, rnd) : pick(answers, rnd);
      const wrong = prev ? other(item.wrongs, prev.choices[1 - prev.correct], rnd) : pick(item.wrongs, rnd);
      const choices = shuffle([answer, wrong], rnd);
      const prompt = prev ? other(item.prompts, prev.prompt, rnd) : pick(item.prompts, rnd);
      return { ...base, prompt, choices, correct: choices.indexOf(answer), answerText: answer };
    }
    if (item.type === "tf") {
      const all = item.trues.map((s) => [s, true]).concat(item.falses.map((s) => [s, false]));
      const [prompt, truth] = prev ? other(all, all.find((x) => x[0] === prev.prompt), rnd) : pick(all, rnd);
      return { ...base, prompt, choices: ["True", "False"], correct: truth ? 0 : 1, answerText: truth ? "True" : "False" };
    }
    throw new Error("unknown type " + item.type);
  }

  function make(bank) {
    const byId = new Map(bank.map((it) => [it.id, it]));
    const E = {
      BANK: bank, GAP,
      build, shuffle, sample,
      generateAttempt(n, rnd) { rnd = rnd || Math.random; return sample(bank, Math.min(n || 10, bank.length), rnd).map((it) => build(it, rnd)); },
      rebuild(q, rnd) { return build(byId.get(q.id), rnd || Math.random, q); },
      // A round is plain JSON, so the page can keep it in sessionStorage and resume after a trip to the slides.
      newRound(n, rnd) { const queue = E.generateAttempt(n, rnd); return { ids: queue.map((q) => q.id), queue, pos: 0, first: {}, misses: {} }; },
      current(r) { return r.queue[r.pos]; },
      done(r) { return r.pos >= r.queue.length; },
      // Record an answer to the current question and move on. A miss puts a reworded copy back into the queue.
      answer(r, ok, rnd) {
        const q = r.queue[r.pos];
        if (!(q.id in r.first)) r.first[q.id] = ok;
        if (!ok) {
          r.misses[q.id] = (r.misses[q.id] || 0) + 1;
          r.queue.splice(Math.min(r.pos + 1 + GAP, r.queue.length), 0, { ...E.rebuild(q, rnd), retry: true });
        }
        r.pos += 1;
        return r;
      },
      firstTry(r) { return r.ids.filter((id) => r.first[id] === true).length; },
    };
    return E;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { make, build, shuffle };
  else root.QuizBank = make(root.QUIZ.bank);
})(typeof globalThis !== "undefined" ? globalThis : this);
