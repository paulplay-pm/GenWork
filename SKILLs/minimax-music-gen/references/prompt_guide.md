# Prompt Writing Guide for MiniMax Music API

This reference helps construct high-quality music generation prompts.

## Core Principle

**Write prompts as vivid English sentences, not comma-separated tags.**

The API responds best to descriptive, narrative-style prompts that paint a complete picture
of the song. Each prompt should read like a creative brief for a musician.

---

## Prompt Structure

A complete prompt follows this sentence pattern:

```
A [mood/emotion] [BPM optional] [genre + sub-genre] [song/piece/track].
[Vocal description OR "Instrumental with..." description].
[Narrative/theme — what the song is about].
[Atmosphere/scene details].
[Key instruments and production elements].
```

### Vocal Track Example

```
A melancholic yet defiant Pop-House song, featuring emotional vocals, about
lighting a torch in the cold dark night as a form of romantic rebellion,
energetic rhythm with synth elements.
```

### Instrumental Example

```
A warm and uplifting 100 BPM indie folk instrumental piece, evoking a sunny
afternoon stroll through a small town market, featuring bright acoustic guitar
fingerpicking, gentle ukulele strums, light hand claps, and a whistled melody
that feels like pure contentment.
```

---

## How to Build a Prompt Step by Step

### 1. Open with mood + genre (required)

Start with the emotional core and musical style:

| Pattern | Example |
|---------|---------|
| Single mood | "A melancholic R&B song" |
| Contrasting moods | "A melancholic yet defiant Pop-House song" |
| With BPM | "A smoky 74 BPM Neo-Soul fusion" |
| With era/region | "A laid-back 90 BPM Island Reggae" |
| Genre blend | "An Avant-Garde Jazz and Neo-Soul fusion" |

### 2. Describe the vocals (for vocal tracks)

Use "featuring..." or "Vocals:..." to describe the singer:

**Good vocal descriptions** (from high-quality demos):
- "featuring smooth emotional vocals"
- "featuring emotional vocals"
- "Vocals: Ultra-low, gravelly baritone with authentic phrasing"
- "Vocals: Sultry, sophisticated male baritone with smooth jazz inflections and breathy delivery"
- "Vocals: Ethereal, crystal-clear Enya-style vocals with lush reverb"
- "Vocals: Relaxed, soul-flavored vocals with ad-libs and melodic scats"

**Bad** (too vague): "female vocal", "温柔女声"

For instrumental tracks, skip this or write:
- "Instrumental with rich orchestral textures"
- "A pure instrumental piece driven by..."

### 3. Add narrative/theme (recommended)

Use "about..." to give the song a story or emotional arc:

- "about lighting a torch in the cold dark night as a form of romantic rebellion"
- "about letting go of perfectionism and embracing your true self like flowing water"
- "about salvaging memory fragments in space-time and letting go of past obsessions"

For instrumentals, describe the scene/journey instead:
- "evoking a sunrise drive along a coastal highway"
- "capturing the energy of a neon-lit city at 2 AM"

### 4. Set the mood/atmosphere (recommended)

Add mood descriptors as a phrase:
- "bittersweet but healing mood"
- "empowering and self-loving mood"
- "the overall vibe is grotesque opulence"

### 5. Specify production elements (recommended)

End with key instruments and production choices:
- "mellow beats with lo-fi elements"
- "rhythmic beats with R&B influences"
- "energetic rhythm with synth elements"
- "featuring a warm fretless bassline, shimmering Rhodes piano, and brushed jazz drums"

---

## Genre Reference

### Pop & Dance
- Pop, Dance Pop, Electropop, Synth-pop, Dream Pop, Indie Pop
- K-pop, J-pop, C-pop, City Pop
- House, Pop-House, Deep House, Progressive House
- Hyperpop, Future Bass, EDM

### Rock & Alternative
- Rock, Indie Rock, Pop Rock, Post-Rock, Shoegaze
- Punk, Garage Rock, Metal, Alternative

### R&B, Soul & Funk
- R&B, Neo-Soul, Contemporary R&B, Funk
- Gospel, Soul, Motown

### Hip-Hop & Rap
- Hip-Hop, Trap, Boom Bap, Lo-fi Hip-Hop
- Cloud Rap, Drill, Afrobeats

### Electronic
- Electronic, Ambient, Techno, Drum and Bass
- Chillwave, Vaporwave, IDM, Glitch
- Amapiano, Afro House

### Folk & Acoustic
- Folk, Indie Folk, Folk Rock, Country
- Chinese Traditional (古风/中国风), Celtic Folk

### Jazz & Blues
- Jazz, Smooth Jazz, Jazz Fusion, Bossa Nova
- Blues, Neo-Soul, Avant-Garde Jazz

### Classical & Cinematic
- Classical, Orchestral, Cinematic, Film Score
- Epic, Neoclassical, Piano Solo
- New Age, Ambient Orchestral

### World & Regional
- Reggae, Latin, Afro, Celtic
- Waltz, Tango, Flamenco

---

## Vocal Style Reference

### By character
| Style | Prompt phrase |
|-------|--------------|
| Smooth & emotional | "smooth emotional vocals" |
| Raw & unpolished | "raw, unpolished vocals shifting between whispers and screams" |
| Breathy & intimate | "breathy delivery with intimate phrasing" |
| Powerful & soulful | "powerful soulful vocals with gospel inflections" |
| Sultry & sophisticated | "sultry, sophisticated baritone with jazz inflections" |
| Ethereal & clear | "ethereal, crystal-clear vocals with lush reverb" |
| Conversational | "conversational delivery with organic mumbles and spontaneous hums" |
| Aggressive & intense | "aggressive vocal delivery with rhythmic intensity" |

### By effect
| Effect | Prompt phrase |
|--------|--------------|
| Auto-tune | "vocals with heavy auto-tune processing" |
| Distorted | "vocals with heavy electronic distortion, mechanical and cold" |
| Reverb-heavy | "vocals drenched in cathedral reverb" |
| Layered | "lush layered vocal harmonies" |
| Call-and-response | "featuring a heavy Gospel Choir providing call-and-response ad-libs" |

---

## Instrument & Production Reference

### Strings & Guitar
- acoustic guitar fingerpicking, electric guitar riffs, distorted guitar
- fretless electric bass, deep sub bass, warm bassline
- violin, cello, orchestral strings, erhu (二胡), guzheng (古筝), pipa (琵琶)

### Keys & Synth
- piano, Rhodes piano, vintage electric piano
- synth pad, synth lead, arpeggiator, analog synthesizer
- music box, accordion, organ

### Drums & Percussion
- brushed jazz drums, live drums, electronic drums
- 808 bass and hi-hats, boom-bap drums, trap percussion
- hand claps, finger snaps, cajón, bongos, bodhrán
- tribal percussion, multi-layered polyrhythmic drums

### Wind & Brass
- saxophone (soprano/alto/tenor), trumpet, trombone
- flute, tin whistle, harmonica
- bamboo flute (竹笛), xiao (箫), suona (唢呐)

### Texture & Effects
- vinyl crackle, tape hiss, lo-fi texture
- ambient pads, atmospheric reverb, delay effects
- glitch elements, laser sounds, industrial noise
- wind chimes, rain sounds, city ambience

---

## BPM Reference

| Feel | BPM | Use in prompt |
|------|-----|---------------|
| Very slow, meditative | 40-60 | "a meditative 50 BPM..." |
| Slow ballad | 60-80 | "a slow 70 BPM ballad..." |
| Mid-tempo groove | 80-110 | "a groovy 95 BPM..." |
| Upbeat, energetic | 110-130 | "an upbeat 120 BPM..." |
| Fast, driving | 130-160 | "a driving 140 BPM..." |
| Very fast, intense | 160+ | "an intense 170 BPM..." |

Note: BPM is optional. Only include it when tempo precision matters.

---

## Complete Prompt Examples

### Emotional Pop (vocal)
```
A melancholic yet defiant Pop-House song, featuring emotional vocals, about
lighting a torch in the cold dark night as a form of romantic rebellion,
energetic rhythm with synth elements.
```

### Neo-Soul Groove (vocal)
```
An uplifting and groovy neo-soul pop song, featuring smooth emotional vocals,
about letting go of perfectionism and embracing your true self like flowing
water, empowering and self-loving mood, rhythmic beats with R&B influences.
```

### Chill R&B (vocal)
```
A reflective and atmospheric chill R&B song, featuring smooth emotional vocals,
about salvaging memory fragments in space-time and letting go of past
obsessions, bittersweet but healing mood, mellow beats with lo-fi elements.
```

### Jazz Lounge (vocal)
```
A smooth 92 BPM Neo-Soul and Contemporary Jazz-Pop. Vocals: Sultry,
sophisticated male baritone with smooth jazz inflections and breathy delivery.
Instrumentation: A melodic, sliding Fretless Electric Bass and lush Rhodes
Piano chords. Features a warm, soulful Soprano Saxophone solo. Percussion:
Snapping crisp rimshots and a subtle Shaker. Vibe: A high-end rooftop lounge
at night. Elegant, modern, and deeply romantic.
```

### Celtic Fantasy (vocal)
```
A magical 85 BPM Celtic Folk and Cinematic Fantasy blend. Vocals: Ethereal,
crystal-clear vocals with lush reverb and wordless high-note echoes.
Instrumentation: A soaring Tin Whistle melody and a rhythmic Bodhrán.
Features the shimmering texture of a Celtic Harp. Percussion: Subtle wind
chimes. Vibe: A hidden fairy garden in an ancient forest. Mystical, soaring,
and peaceful.
```

### Avant-Garde Jazz (vocal)
```
A smoky 74 BPM Avant-Garde Jazz and Neo-Soul fusion. Vocals: Ultra-low,
gravelly baritone with conversational, non-linear delivery, featuring organic
mumbles, spontaneous hums, and erratic jazz scats. Instrumentation: A warm,
wandering fretless bassline with deep sub-extension, shimmering Rhodes piano,
and brushed jazz drums. Atmosphere: Integrated city ambience and vinyl crackle.
Wide dynamic range, shifting from minimalist bass-and-vocal sections to lush,
spiritually ascending harmonies.
```

### Island Reggae (vocal)
```
A laid-back 90 BPM Island Reggae. Vocals: Relaxed, soul-flavored vocals with
ad-libs and melodic scats. Instrumentation: The bright, tropical sound of
Steel Drums and a rhythmic Ukulele strum. Percussion: A steady one-drop
reggae beat with Bongos. Vibe: A birthday party on a Caribbean island.
Carefree, sunny, and rhythmic.
```

### Cinematic Instrumental
```
A sweeping cinematic orchestral piece building from a solitary piano melody
into a full symphonic crescendo, evoking the feeling of standing on a
mountaintop at dawn watching the world awaken below, featuring soaring
strings, triumphant brass, and thundering timpani.
```

### Lo-fi Study Beats (instrumental)
```
A calm and dreamy lo-fi hip-hop instrumental, capturing late-night study
vibes with soft rain outside the window, featuring sampled jazz piano chords,
mellow electronic drums with tape saturation, gentle vinyl crackle, and a
wandering bass that feels like drifting between thoughts.
```

### Chinese Traditional (instrumental)
```
An elegant and poetic Chinese traditional instrumental piece, evoking moonlit
reflections on a still lake in an ancient garden, featuring delicate guzheng
arpeggios, flowing bamboo flute melodies, soft pipa plucks, and subtle
orchestral strings that swell like mist rising at dawn.
```

### EDM / Electronic (instrumental)
```
A high-energy 130 BPM progressive electronic instrumental with a massive
synth build-up crashing into a euphoric drop, pulsing sidechain bass,
crystalline arpeggiated synths, and cinematic breakdown sections that feel
like floating through neon-lit clouds before the beat slams back in.
```

---

## Tips for High-Quality Prompts

1. **Write sentences, not tag lists**: "A melancholic R&B song about..." beats
   "R&B, 忧郁, 慢板, 钢琴".
2. **Be vivid and specific**: "salvaging memory fragments in space-time" is far
   more evocative than "sad memories".
3. **Describe vocals as a character**: Give them personality, not just gender.
   "Sultry baritone with jazz inflections" not "male vocal".
4. **Include a scene or vibe**: "A high-end rooftop lounge at night" gives the
   model a coherent world to build around.
5. **Mix detail levels**: Specify 2-3 key instruments precisely, leave the rest
   to the model. Over-specifying everything can constrain creativity.
6. **BPM is optional but powerful**: Use it when tempo precision matters for
   your use case (e.g., video editing, dance choreography).
7. **English prompts work best**: The model responds most reliably to English
   prompts. Chinese scene descriptions can be mixed in for flavor.
8. **For instrumentals**: Replace vocal descriptions with instrument focus and
   scene/journey narrative. Use "instrumental" or "instrumental piece" explicitly.
