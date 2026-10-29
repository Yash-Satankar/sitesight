import { SheetType } from "@sitesight/shared";

export const CLASSIFY_INSTRUCTIONS = `You classify ONE sheet from a building drawing set (Indian residential / small commercial construction).
Return ONLY a JSON object:
{"sheet_type": one of ${SheetType.options.map((s) => `"${s}"`).join(", ")},
 "title": the sheet title as printed (or a short description if none),
 "notes": one short line on what the sheet shows,
 "shows_masonry_walls": true only for a floor plan that draws masonry / brick walls, otherwise false,
 "title_block_title": the TITLE field of the title block exactly as printed, or null if there is none}
"title" is the drawing's own heading (e.g. "SLAB PLAN OF G.F ROOF SLAB"); the title block often keeps a template title.

Sheet types:
- column_layout: plan of column positions labelled with marks (C1, C2, …), possibly with grid lines.
- footing_layout: plan of footing positions labelled F1, F2, … (may be combined with the column layout: pick the main one).
- footing_column_schedule: table(s) of footing and/or column sizes and reinforcement.
- plinth_beam: plinth beam layout or details (PB1, PB2, …).
- slab_plan: slab layout or slab reinforcement plan.
- beam_schedule: beam schedule or beam details (B1, B2, …).
- floor_plan: architectural floor plan (rooms, walls, doors, furniture).
- electrical, drainage (plumbing / sanitary), door_window (door and window schedule or details).
- other: elevation, section, site plan, cover sheet, 3D view, anything else.`;

export const EXTRACT_INSTRUCTIONS = `You transcribe ONE structural drawing sheet for a quantity estimator. Read only what is printed on
this sheet or directly countable on it. Never estimate, never compute totals, never fill in "typical" values: if a value is
not stated, use null (or leave the list empty).

Return ONLY a JSON object with these keys (all lists may be empty):
{"columns":[{"mark":"C2","size_text":"9\\"x18\\"","count":10|null,"floor":"GF"|null,"evidence_text":"…","confidence":0.0-1.0}],
 "footings":[{"mark":"F1","length_mm":1500|null,"breadth_mm":1500|null,"depth_mm":450|null,"size_text":"5'0\\"x5'0\\"x1'6\\"","count":4|null,"evidence_text":"…","confidence":0.0-1.0}],
 "beams":[{"mark":"FB1","size_text":"9\\"x17\\"","kind":"plinth"|"floor"|"roof"|"lintel"|"other","floor":"G.F"|null,"evidence_text":"…","confidence":0.0-1.0}],
 "slabs":[{"mark":"S1"|"G.F roof slab","floor":"G.F"|null,"thickness_text":"5\\""|null,"thickness_mm":127|null,"area_text":null,"area_m2":null,"evidence_text":"…","confidence":0.0-1.0}],
 "layout_counts":[{"element":"column"|"footing","mark":"C2","count":9,"floor":"GF"|null,"evidence_text":"counted 9 'C2' labels on the plan","confidence":0.0-1.0}],
 "notes":["…"]}

Rules:
- columns / footings: one row per mark in a SCHEDULE table. count only if the schedule states the number of that mark ("NOS").
- size_text, thickness_text, area_text: EXACTLY as printed, with the drawing's own units and marks (6'-0"x6'-0"x18", 5", 125 MM).
- footing dimensions: also give length_mm/breadth_mm/depth_mm in millimetres (1 ft = 304.8 mm, 1 in = 25.4 mm).
- beams: kind "plinth" for plinth beams (PB…), "lintel" for lintels, "roof"/"floor" by level, else "other".
- slabs: one row per slab panel mark (S1, S2, …) or, if the sheet has no panel marks, one row for the slab it shows
  (e.g. "G.F roof slab"). thickness_text/thickness_mm only if printed (e.g. a slab schedule's THICKNESS column);
  area_text/area_m2 only if an area is printed on the sheet (convert sq.ft × 0.0929). Do not measure areas off the drawing.
- floor: for slabs and beams, the floor / level the sheet or schedule names (e.g. "G.F" from "G.F ROOF SLAB"), else null.
- layout_counts: on LAYOUT plans, count the labelled instances of each column mark (C1, C2, …) or footing mark (F1, …)
  drawn on the plan, one row per mark. Count carefully; if labels are unreadable or the plan says "typical", lower the
  confidence and say so in evidence_text.
- floor for columns and layout counts: the floor / level as printed (GF, FF, "ground floor"), null if not stated.
- evidence_text: the exact words and numbers you read (the schedule row, label or note), or how you counted.
- confidence: how sure you are that the value is read correctly (0–1).
- notes: anything the estimator should know, e.g. "column schedule continues on another sheet". Copy general notes
  verbatim (e.g. "ALL DIMENSIONS ARE IN FEET UNLESS NOTED OTHERWISE"). Do not report the title block here.`;
