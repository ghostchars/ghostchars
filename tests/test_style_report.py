#!/usr/bin/env python3
"""style_report.py: a machine-shaped text and a human-shaped text on the same topic
must separate in the right direction on every metric; edge cases must not crash."""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import style_report as sr  # noqa: E402

fails = []
def check(desc, cond, got=""):
    print(("  ok  " if cond else " FAIL ") + desc + ("" if cond else f"   got={got!r}"))
    if not cond:
        fails.append(desc)

MACHINE = """In today's ever-evolving digital landscape, remote work has become a crucial aspect of modern business. Companies must navigate a wide range of challenges to foster a robust and seamless remote culture. It's important to note that effective communication plays a pivotal role in this transformative journey.

Furthermore, leveraging innovative tools can enhance collaboration across distributed teams. Moreover, organizations should embrace a holistic approach that empowers employees to thrive. Additionally, it is essential to establish clear expectations and meticulous processes.

**Communication:** Regular check-ins foster alignment and trust across the team.
**Flexibility:** Empowering employees to choose their hours enhances productivity.
**Well-being:** A holistic focus on mental health underscores a company's values.

Ultimately, remote work isn't just a trend — it's a fundamental shift in how we approach work. It's not about where you work, but how you work. Companies that delve into these nuances will unlock a myriad of benefits — engagement, retention, and innovation.

In conclusion, the realm of remote work offers a rich tapestry of opportunities. By navigating these challenges thoughtfully, organizations can harness its full potential and embark on a path toward sustained success."""

HUMAN = """I ran a nine-person team from three time zones for two years and I'd do it again, with caveats. The first six months were bad. Not "we need better tooling" bad — Slack-at-11pm-because-nobody-knew-when-anyone-was-working bad.

What fixed it wasn't a tool. It was one rule: no meetings before 10am Riga time or after 4pm, and if you can't make that window you post a Loom. Meetings dropped from 14 hours a week to about 5. Kirill, our lead engineer in Tbilisi, said it was the first time since 2020 he'd finished a feature without a calendar reminder interrupting him.

The thing nobody tells you is that async only works if people write well, and most engineers don't, at first. We spent real money on it — a writing coach, $2,400 for the quarter, which our CFO thought was insane until Q3 support tickets dropped 30% because the docs stopped being wrong.

Would I recommend it? Depends. If your team is under five people and in one country, honestly, just get an office. Above that, across borders, remote wins, but only if you're willing to be the person who says no to the 9pm call. Every single time."""


print("=== separation: machine vs human ===")
m, h = sr.analyze(MACHINE), sr.analyze(HUMAN)
check("both parse into sentences", m["sentences"] > 8 and h["sentences"] > 8, (m["sentences"], h["sentences"]))
check("machine cv < human cv (uniformity)", m["sentence_length"]["cv"] < h["sentence_length"]["cv"],
      (m["sentence_length"]["cv"], h["sentence_length"]["cv"]))
check("machine tell density > human", m["tell_density_per_1000"] > h["tell_density_per_1000"] * 5,
      (m["tell_density_per_1000"], h["tell_density_per_1000"]))
check("machine detects delve/tapestry/landscape/navigate", all(k in m["tell_words"] for k in ("delve", "tapestry", "landscape", "navigate")), m["tell_words"])
check("machine detects 'in conclusion' + 'it's important to note'", "in conclusion" in m["tell_phrases"] and "it's important to note" in m["tell_phrases"], m["tell_phrases"])
check("machine flags stock transitions", sum(m["sentence_initial_transitions"].values()) >= 3, m["sentence_initial_transitions"])
check("machine flags not-X-but-Y", m["not_x_but_y"] >= 2, m["not_x_but_y"])
check("machine flags bold-lead bullets", m["bold_lead_bullets"] == 3, m["bold_lead_bullets"])
check("machine has more em dashes per 1000", m["em_dashes_per_1000"] > h["em_dashes_per_1000"], (m["em_dashes_per_1000"], h["em_dashes_per_1000"]))
check("contractions reported for both (weak signal; not directional)", h["contractions_per_1000"] > 0 and m["contractions_per_1000"] > 0)
check("human has more numbers", h["numbers_per_1000"] > m["numbers_per_1000"], (h["numbers_per_1000"], m["numbers_per_1000"]))
check("human has first person, machine none", h["first_person_per_1000"] > 0 and m["first_person_per_1000"] < h["first_person_per_1000"], (h["first_person_per_1000"], m["first_person_per_1000"]))
check("human has more proper nouns", h["proper_nouns_per_1000"] > m["proper_nouns_per_1000"], (h["proper_nouns_per_1000"], m["proper_nouns_per_1000"]))
mh = m["summary"]["high"] + m["summary"]["medium"]
hh = h["summary"]["high"] + h["summary"]["medium"]
check("machine gets ≥4 high/medium observations", mh >= 4, m["observations"])
check("human gets ≤1 high/medium observation", hh <= 1, [o["title"] for o in h["observations"] if o["severity"] != "low"])
check("machine has ≥1 high", m["summary"]["high"] >= 1, m["summary"])
check("human has 0 high", h["summary"]["high"] == 0, [o["title"] for o in h["observations"]])
titles = {o["title"] for o in m["observations"]}
check("machine: summarizing sign-off flagged", "summarizing sign-off" in titles, titles)
check("machine: 'it's not X, it's Y' flagged", "'it's not X, it's Y' framing" in titles, titles)
check("machine: dense vocabulary flagged", "dense LLM vocabulary" in titles, titles)
check("machine: **Term:** bullets flagged", "'**Term:** explanation' bullets" in titles, titles)

print("\n=== segmentation ===")
s = sr.sentences("Dr. Smith paid $3.50 at 5 p.m. He left. Was it e.g. late? Yes!")
check("'Dr.' and '$3.50' don't split", s[0].startswith("Dr. Smith paid $3.50"), s)
check("'p.m. He' IS a boundary (capital follows)", "He left." in s, s)
check("no false split on 'e.g.'", "Was it e.g. late?" in s, s)
check("quotes after period handled", len(sr.sentences('He said "no." "Fine," she said. Done.')) >= 2)

print("\n=== edge cases ===")
for label, txt in (("empty", ""), ("one word", "Hello"), ("one sentence", "Just one sentence here."),
                   ("no punctuation", "words and more words without any stop at all"),
                   ("only bullets", "- a\n- b\n- c\n"), ("unicode", "Привет мир. Ça va? 東京。")):
    try:
        r = sr.analyze(txt)
        check(f"{label}: no crash, has summary", "summary" in r and "observations" in r)
    except Exception as e:  # noqa: BLE001
        check(f"{label}: no crash", False, repr(e))
r = sr.analyze("Short. Also short. Very short.")
check("short text yields no observations (below thresholds)", r["observations"] == [], r["observations"])

print("\n=== CLI ===")
S = os.path.join(HERE, "..", "style_report.py")
p = subprocess.run([sys.executable, S, "--json"], input=MACHINE.encode(), capture_output=True)
j = json.loads(p.stdout)
check("--json emits valid JSON with expected keys", all(k in j for k in ("words", "sentence_length", "tell_words", "observations", "summary")), list(j)[:8])
p = subprocess.run([sys.executable, S], input=HUMAN, capture_output=True, text=True)
check("text mode prints header + metrics", "words" in p.stdout and "per 1000 words" in p.stdout, p.stdout[:200])
check("text mode never prints a probability", "%" not in p.stdout.split("per 1000")[0] and "probab" not in p.stdout.lower(), p.stdout)

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILURES: {fails}"))
sys.exit(1 if fails else 0)
