import { SheetType } from "@sitesight/shared";

export const CLASSIFY_INSTRUCTIONS = `You classify ONE sheet from a building drawing set (Indian residential / small commercial construction).
Return ONLY a JSON object:
{"sheet_type": one of ${SheetType.options.map((s) => `"${s}"`).join(", ")},
 "title": the sheet title as printed (or a short description if none),
 "notes": one short line on what the sheet shows,
 "shows_masonry_walls": true only for a floor plan that draws masonry / brick walls, otherwise false}

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
 "beams":[{"mark":"PB1","size_text":"9\\"x12\\"","kind":"plinth"|"floor"|"roof"|"lintel"|"other","evidence_text":"…","confidence":0.0-1.0}],
 "slabs":[{"mark":"S1"|"roof slab","floor":"GF"|null,"thickness_mm":125|null,"area_m2":null,"evidence_text":"…","confidence":0.0-1.0}],
 "layout_counts":[{"element":"column"|"footing","mark":"C2","count":9,"floor":"GF"|null,"evidence_text":"counted 9 'C2' labels on the plan","confidence":0.0-1.0}],
 "notes":["…"]}

Rules:
- columns / footings: one row per mark in a SCHEDULE table. count only if the schedule states the number of that mark ("NOS").
- footing dimensions: convert to millimetres (1 ft = 304.8 mm, 1 in = 25.4 mm); keep size_text exactly as printed.
- beams: kind "plinth" for plinth beams (PB…), "lintel" for lintels, "roof"/"floor" by level, else "other".
- slabs: thickness_mm only if printed (e.g. "SLAB THK 125 MM" or 5"); area_m2 only if an area is printed on the sheet
  (convert sq.ft × 0.0929). Do not measure areas off the drawing.
- layout_counts: on LAYOUT plans, count the labelled instances of each column mark (C1, C2, …) or footing mark (F1, …)
  drawn on the plan, one row per mark. Count carefully; if labels are unreadable or the plan says "typical", lower the
  confidence and say so in evidence_text.
- floor: the floor / level as printed (GF, FF, "ground floor"), null if not stated.
- evidence_text: the exact words and numbers you read (the schedule row, label or note), or how you counted.
- confidence: how sure you are that the value is read correctly (0–1).
- notes: anything the estimator should know, e.g. "column schedule continues on another sheet".`;
