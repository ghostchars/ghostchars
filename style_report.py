#!/usr/bin/env python3
"""Why does this text read as machine-written? A deterministic editing report.

    style_report.py draft.md            # human-readable report
    style_report.py --json draft.md     # machine-readable, for the web UI
    pbpaste | style_report.py

This is NOT a detector and produces no "AI probability". Detectors such as
GPTZero score perplexity (how predictable each word is) and burstiness (how much
that varies sentence to sentence) with a trained classifier on top; nothing at
the character level touches that. What this report does is surface the
measurable habits that make a draft read as generated: uniform sentence length,
uniform paragraph shape, tell-words, stock transitions, em-dash density,
"it's not X, it's Y" framing, tricolons, absence of specifics, so a writer can
edit them out. Every number is computed from the text in front of you; nothing
is sent anywhere.
"""
import argparse
import json
import re
import statistics
import sys
from collections import Counter

# ---------------------------------------------------------------- lexicon ----

# Words and phrases heavily over-represented in LLM prose relative to human
# writing (from published corpus comparisons of pre/post-2023 text). Presence is
# not proof of anything; density is what matters.
TELL_WORDS = [
    "delve", "delves", "delving", "tapestry", "testament", "landscape", "navigate",
    "navigating", "crucial", "robust", "leverage", "leveraging", "foster", "fostering",
    "underscore", "underscores", "pivotal", "multifaceted", "realm", "embark", "unlock",
    "harness", "seamless", "seamlessly", "holistic", "elevate", "resonate", "intricate",
    "nuanced", "meticulous", "meticulously", "vibrant", "paramount", "comprehensive",
    "streamline", "transformative", "groundbreaking", "cutting-edge", "ever-evolving",
    "game-changer", "showcase", "showcasing", "myriad", "plethora", "utilize",
    "facilitate", "endeavor", "commendable", "invaluable", "unwavering", "captivate",
    "captivating", "enhance", "enhancing", "empower", "empowering", "innovative",
    "dynamic", "synergy", "bustling", "beacon", "journey", "unleash", "revolutionize",
]
TELL_PHRASES = [
    "in today's", "in the ever-evolving", "it's important to note", "it is important to note",
    "it's worth noting", "it is worth noting", "in conclusion", "in summary", "to summarize",
    "ultimately,", "furthermore,", "moreover,", "additionally,", "that being said",
    "at the end of the day", "plays a crucial role", "plays a vital role", "a wide range of",
    "a variety of", "dive into", "let's explore", "let's dive", "as an ai", "in the realm of",
    "when it comes to", "a testament to", "the importance of", "it is essential to",
    "it's essential to", "not only", "serves as a", "in order to", "look no further",
    "whether you're", "here's the thing", "the bottom line", "in a world where",
    "as we navigate", "the world of", "rich tapestry", "shed light on", "stands as",
    "i hope this helps", "feel free to", "certainly!", "great question",
]
TRANSITIONS = ["furthermore", "moreover", "additionally", "however", "therefore", "thus",
               "consequently", "in addition", "on the other hand", "nevertheless",
               "nonetheless", "ultimately", "overall", "in essence", "importantly"]
HEDGES = ["may", "might", "can", "could", "often", "generally", "typically", "tend to",
          "tends to", "in many cases", "it is possible", "potentially", "arguably",
          "to some extent", "in some ways", "various", "numerous", "several"]

NOT_X_BUT_Y_RE = re.compile(
    r"\b(?:it'?s|this is|that'?s|isn'?t|is not|not just|not only|not merely|not simply)\b"
    r"[^.!?\n]{2,80}?\b(?:but|it'?s|rather|instead)\b", re.I)
TRICOLON_RE = re.compile(r"\b\w[\w'-]*,\s+\w[\w'-]*,?\s+(?:and|or)\s+\w[\w'-]*\b")
CONTRACTION_RE = re.compile(r"\b\w+'(?:t|s|re|ve|ll|d|m)\b", re.I)
FIRST_PERSON_RE = re.compile(r"\b(?:I|I'm|I've|I'd|I'll|me|my|mine|we|we're|we've|our|us)\b")
NUMBER_RE = re.compile(r"\b\d[\d,.]*%?\b")
# A capitalized word directly after a lowercase word: a cheap proper-noun proxy
# that ignores sentence/line starts and bold bullet leads.
PROPER_RE = re.compile(r"(?<=[a-z,;] )[A-Z][a-z]{2,}\b")
BULLET_RE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+", re.M)
HEADING_RE = re.compile(r"^\s*#{1,6}\s+\S|^[A-Z][^\n]{2,60}:\s*$", re.M)
# "**Term:** text", "**Term**: text", "**Term** — text", optionally as a bullet
BOLD_LEAD_RE = re.compile(r"^\s*(?:[-*•]\s+|\d+[.)]\s+)?\*\*[^*\n]{2,60}?(?::\*\*|\*\*\s*[:—–-])", re.M)
ABBREV = {"mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e",
          "u.s", "u.k", "no", "fig", "inc", "ltd", "co", "approx", "dept"}


# ------------------------------------------------------------ segmentation ----

def paragraphs(text):
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def sentences(par):
    """Split a paragraph into sentences; forgiving of abbreviations and decimals."""
    par = re.sub(r"\s+", " ", par).strip()
    out, start = [], 0
    for m in re.finditer(r"[.!?]+(?=\s+[\"'“(]?[A-Z0-9]|\s*$)", par):
        end = m.end()
        prev = par[start:end]
        last = re.search(r"(\w[\w.]*)[.!?]+$", prev)
        if last and last.group(1).lower().rstrip(".") in ABBREV:
            continue
        out.append(prev.strip())
        start = end
    tail = par[start:].strip()
    if tail:
        out.append(tail)
    return [s for s in out if re.search(r"\w", s)]


def word_count(s):
    return len(re.findall(r"\b[\w'-]+\b", s))


# ---------------------------------------------------------------- analysis ----

def per_k(n, words):
    return round(1000 * n / words, 1) if words else 0.0


def analyze(text):
    pars = paragraphs(text)
    sents = [s for p in pars for s in sentences(p)]
    lens = [word_count(s) for s in sents]
    words = sum(lens)
    low = text.lower()

    r = {"words": words, "sentences": len(sents), "paragraphs": len(pars),
         "observations": []}
    obs = r["observations"]

    # -- sentence length / burstiness
    if len(lens) >= 2:
        mean = statistics.mean(lens)
        sd = statistics.pstdev(lens)
        cv = sd / mean if mean else 0
        buckets = Counter("1-8" if n <= 8 else "9-15" if n <= 15 else "16-25" if n <= 25
                          else "26-40" if n <= 40 else "41+" for n in lens)
        r["sentence_length"] = {"mean": round(mean, 1), "stdev": round(sd, 1),
                                "cv": round(cv, 2), "min": min(lens), "max": max(lens),
                                "histogram": {k: buckets.get(k, 0)
                                              for k in ("1-8", "9-15", "16-25", "26-40", "41+")}}
        if len(lens) >= 5:
            if cv < 0.35:
                obs.append(("high", "uniform sentence length",
                            f"sentences average {mean:.0f} words with very little variation "
                            f"(cv {cv:.2f}). Human prose usually mixes very short and long "
                            f"sentences; this is the single strongest 'generated' signal."))
            elif cv < 0.5:
                obs.append(("medium", "fairly uniform sentence length",
                            f"cv {cv:.2f}; a few deliberately short or long sentences would help."))
            if buckets.get("1-8", 0) == 0:
                obs.append(("medium", "no short sentences",
                            "not one sentence under nine words. Add a punchy one."))
    # -- paragraph shape
    per_par = [len(sentences(p)) for p in pars]
    if len(per_par) >= 4:
        psd = statistics.pstdev(per_par)
        r["paragraph_shape"] = {"sentences_per_paragraph_mean": round(statistics.mean(per_par), 1),
                                "stdev": round(psd, 1)}
        if psd < 0.8:
            obs.append(("medium", "uniform paragraph shape",
                        f"every paragraph has about {statistics.mean(per_par):.0f} sentences. "
                        "Generated drafts are metronomic; let one paragraph run long and one be a line."))
    # -- tells
    tw = Counter()
    for w in TELL_WORDS:
        n = len(re.findall(rf"\b{re.escape(w)}\b", low))
        if n:
            tw[w] = n
    tp = Counter()
    for ph in TELL_PHRASES:
        n = low.count(ph)
        if n:
            tp[ph] = n
    r["tell_words"] = dict(tw.most_common())
    r["tell_phrases"] = dict(tp.most_common())
    tell_total = sum(tw.values()) + sum(tp.values())
    r["tell_density_per_1000"] = per_k(tell_total, words)
    if words >= 80:
        if r["tell_density_per_1000"] >= 12:
            obs.append(("high", "dense LLM vocabulary",
                        f"{tell_total} tell-words/phrases in {words} words "
                        f"({r['tell_density_per_1000']}/1000): "
                        + ", ".join(f"{k}×{v}" for k, v in (tw + tp).most_common(6))))
        elif r["tell_density_per_1000"] >= 5:
            obs.append(("medium", "noticeable LLM vocabulary",
                        ", ".join(f"{k}×{v}" for k, v in (tw + tp).most_common(6))))
    # -- transitions at sentence start
    starts = Counter()
    for s in sents:
        head = s.lower().lstrip("\"'“(")
        for t in TRANSITIONS:
            if head.startswith(t):
                starts[t] += 1
    r["sentence_initial_transitions"] = dict(starts)
    if sents and sum(starts.values()) / len(sents) >= 0.15 and sum(starts.values()) >= 3:
        obs.append(("medium", "stock transitions",
                    f"{sum(starts.values())} of {len(sents)} sentences open with "
                    + "/".join(starts) + ". Cut most; the logic usually survives without them."))
    # -- punctuation habits
    em = text.count("—") + text.count("–")
    r["em_dashes_per_1000"] = per_k(em, words)
    if words >= 80 and em >= 4 and r["em_dashes_per_1000"] >= 15:
        obs.append(("medium", "em-dash habit",
                    f"{em} dashes in {words} words — one every {words // em} words. Humans use "
                    "them; models lean on them. Replace most with commas, colons or full stops."))
    nxy = NOT_X_BUT_Y_RE.findall(text)
    r["not_x_but_y"] = len(nxy)
    if len(nxy) >= 2:
        obs.append(("high", "'it's not X, it's Y' framing",
                    f"{len(nxy)} instances. This contrast template is one of the most "
                    "recognizable generated rhythms."))
    tri = TRICOLON_RE.findall(text)
    r["tricolons"] = len(tri)
    if sents and len(tri) / len(sents) >= 0.25 and len(tri) >= 3:
        obs.append(("medium", "tricolon habit",
                    f"{len(tri)} three-item lists ('a, b, and c'). Vary to two or four, or drop the list."))
    hedges = sum(len(re.findall(rf"\b{re.escape(h)}\b", low)) for h in HEDGES)
    r["hedges_per_1000"] = per_k(hedges, words)
    if words >= 80 and r["hedges_per_1000"] >= 25:
        obs.append(("low", "heavy hedging",
                    f"{hedges} hedges (may/might/often/typically/various…). Commit to claims."))
    # -- structure
    bullets = len(BULLET_RE.findall(text))
    headings = len(HEADING_RE.findall(text))
    bold_leads = len(BOLD_LEAD_RE.findall(text))
    r["bullets"], r["headings"], r["bold_lead_bullets"] = bullets, headings, bold_leads
    if bold_leads >= 3:
        obs.append(("high", "'**Term:** explanation' bullets",
                    f"{bold_leads} bold-lead bullets. This exact shape is a chatbot default."))
    if pars and bullets >= 6 and bullets >= len(pars):
        obs.append(("medium", "bullet-heavy",
                    f"{bullets} bullets across {len(pars)} paragraphs. Prose that should be prose."))
    if re.search(r"\bin (?:conclusion|summary)\b", low[-400:]) or "to summarize" in low[-400:]:
        obs.append(("medium", "summarizing sign-off",
                    "the text ends with 'In conclusion / In summary'. Essays for teachers end "
                    "that way; almost nothing else does."))
    # -- specificity / voice (absence of these is the signal)
    r["contractions_per_1000"] = per_k(len(CONTRACTION_RE.findall(text)), words)
    r["first_person_per_1000"] = per_k(len(FIRST_PERSON_RE.findall(text)), words)
    r["numbers_per_1000"] = per_k(len(NUMBER_RE.findall(text)), words)
    r["proper_nouns_per_1000"] = per_k(len(PROPER_RE.findall(text)), words)
    if words >= 150:
        if r["contractions_per_1000"] == 0:
            obs.append(("low", "no contractions",
                        "zero contractions in the whole text: reads formal-generic. Fine for a "
                        "legal brief; a tell in a blog post or essay."))
        if r["numbers_per_1000"] < 3 and r["proper_nouns_per_1000"] < 5:
            obs.append(("medium", "no specifics",
                        "almost no numbers, names or places. Generated text is generic by "
                        "construction; one concrete detail per paragraph changes the read entirely."))
        if r["first_person_per_1000"] == 0:
            obs.append(("low", "no first person",
                        "no I/we anywhere. Not wrong, but a stance or an experience is the "
                        "cheapest way to sound like a person."))

    sev = Counter(s for s, _, _ in obs)
    r["summary"] = {"high": sev.get("high", 0), "medium": sev.get("medium", 0),
                    "low": sev.get("low", 0)}
    r["observations"] = [{"severity": s, "title": t, "detail": d} for s, t, d in obs]
    return r


# ------------------------------------------------------------------ output ----

def render(r, label):
    lines = [f"{label}: {r['words']} words · {r['sentences']} sentences · {r['paragraphs']} paragraphs"]
    sl = r.get("sentence_length")
    if sl:
        h = sl["histogram"]
        lines.append(f"  sentence length  mean {sl['mean']}  sd {sl['stdev']}  cv {sl['cv']}  "
                     f"range {sl['min']} to {sl['max']}   "
                     f"[1-8:{h['1-8']} 9-15:{h['9-15']} 16-25:{h['16-25']} 26-40:{h['26-40']} 41+:{h['41+']}]")
    lines.append(f"  per 1000 words   tells {r['tell_density_per_1000']}  em-dashes {r['em_dashes_per_1000']}  "
                 f"hedges {r['hedges_per_1000']}  contractions {r['contractions_per_1000']}  "
                 f"first-person {r['first_person_per_1000']}  numbers {r['numbers_per_1000']}")
    if r["tell_words"] or r["tell_phrases"]:
        top = Counter(r["tell_words"]) + Counter(r["tell_phrases"])
        lines.append("  tells            " + ", ".join(f"{k}×{v}" for k, v in top.most_common(10)))
    if not r["observations"]:
        lines.append("  no strong machine-prose habits detected (this is not proof of anything)")
    else:
        s = r["summary"]
        lines.append(f"  observations     {s['high']} high · {s['medium']} medium · {s['low']} low")
        for o in r["observations"]:
            lines.append(f"    [{o['severity']:<6}] {o['title']}: {o['detail']}")
    return "\n".join(lines)


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("files", nargs="*", help="files to analyze (default: stdin)")
    p.add_argument("--json", action="store_true", help="emit JSON")
    args = p.parse_args()

    results = {}
    for path in args.files or [None]:
        label = path or "<stdin>"
        if path is None:
            text = sys.stdin.read()
        else:
            try:
                with open(path, encoding="utf-8") as f:
                    text = f.read()
            except (UnicodeDecodeError, OSError) as e:
                print(f"{label}: {e}", file=sys.stderr)
                continue
        results[label] = analyze(text)
        if not args.json:
            print(render(results[label], label))
            if len(args.files) > 1:
                print()
    if args.json:
        print(json.dumps(results if len(results) != 1 else next(iter(results.values())),
                         indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
