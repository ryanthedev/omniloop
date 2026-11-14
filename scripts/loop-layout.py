#!/usr/bin/env python3
"""Build Herdr's loops layout from another layout (the source is never changed): the tab bar becomes
loop-tabs and pane headers become loop-pane. The status bar gets no loop-status block: a stale
loop-status or team block is dropped from it, and every other child is left as it is.
Usage: loop-layout.py <source layout.json> <loops layout.json>"""
import json, sys

src, dest = sys.argv[1], sys.argv[2]
SWAP = {"tabs": "loop-tabs", "pane": "loop-pane"}
doc = json.load(open(src))
changed = []

def walk(node):
    if isinstance(node, dict):
        c = node.get("content")
        if isinstance(c, dict) and c.get("mod") in SWAP:
            changed.append(f'{c["mod"]} -> {SWAP[c["mod"]]}')
            c["mod"] = SWAP[c["mod"]]
        if node.get("id") == "status-bar" and isinstance(node.get("children"), list):
            kids = [k for k in node["children"] if k.get("id") not in ("team", "loop-status")]
            if len(kids) != len(node["children"]):
                node["children"] = kids
                changed.append("status bar: stale loop-status/team block dropped")
        for v in node.values():
            walk(v)
    elif isinstance(node, list):
        for v in node:
            walk(v)

walk(doc)
json.dump(doc, open(dest, "w"), indent=2)
print(f"{dest}: " + ("; ".join(changed) or "nothing changed"))
