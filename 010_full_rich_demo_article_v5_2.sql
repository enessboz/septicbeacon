-- RVFixWise v5.2 — Full rich demo article
-- Run once in Supabase SQL Editor.
-- This creates/updates a long published demo article that exercises every major article component.

do $$
declare
  v_site uuid;
  v_category uuid;
  v_article uuid;
begin
  select id into v_site
  from public.sites
  where domain='rvfixwise.com'
  limit 1;

  if v_site is null then
    raise exception 'RVFixWise site record not found';
  end if;

  select id into v_category
  from public.categories
  where site_id=v_site and slug='plumbing'
  limit 1;

  if v_category is null then
    select id into v_category
    from public.categories
    where site_id=v_site
    order by sort_order nulls last, created_at
    limit 1;
  end if;

  insert into public.articles (
    site_id,
    category_id,
    title,
    slug,
    content_type,
    status,
    primary_keyword,
    search_intent,
    excerpt,
    seo_title,
    meta_description,
    canonical_path,
    content_markdown,
    featured_image_url,
    featured_image_alt,
    reviewer_required,
    published_at,
    first_published_at
  )
  values (
    v_site,
    v_category,
    'RV Water Pump Troubleshooting: A Complete Step-by-Step Diagnostic Guide',
    'rv-water-pump-troubleshooting-complete-demo',
    'troubleshooting',
    'published',
    'rv water pump troubleshooting',
    'Help RV owners diagnose a running, cycling, weak or non-working water pump before replacing parts.',
    'A complete RV water pump troubleshooting guide covering no-water symptoms, weak flow, cycling, 12V checks, priming, leaks, strainers, valves and replacement decisions.',
    'RV Water Pump Troubleshooting: Complete Diagnostic Guide | RVFixWise',
    'Diagnose RV water pump problems step by step. Check water supply, valves, strainers, air leaks, 12V power, pressure issues and pump condition before replacing parts.',
    '/blog/rv-water-pump-troubleshooting-complete-demo',
    $md$
An RV water pump can fail in several very different ways. It may run continuously without delivering water, cycle every few minutes when every faucet is closed, produce weak or pulsing flow, refuse to start, or sound completely normal while the plumbing system remains dry.

The important point is that **the pump itself is only one part of the system**. A water supply problem, valve position, clogged strainer, air leak, loose electrical connection or pressure-side leak can create symptoms that look like a failed pump.

This guide uses a symptom-first diagnostic process so you can narrow the problem down before buying replacement parts.

> Safety first: switch off the pump and the relevant 12V circuit before disconnecting wiring, removing pressurized fittings or working around wet electrical connections. If you see overheated wiring, damaged insulation or evidence of a leak near electrical equipment, stop and have the system inspected professionally.

## Quick diagnostic overview

Start with the simplest conditions first. Confirm that there is actually water available to the pump, verify the winterization and tank-selection valves, inspect the inlet strainer, and make sure the pump is not trying to draw through an empty or blocked line.

![RV plumbing system overview](/demo-media/plumbing.webp "Example plumbing-system visual used to demonstrate inline article imagery")

The table below gives you a fast way to choose your first diagnostic direction.

| Symptom | First thing to check | Likely direction |
|---|---|---|
| Pump runs but no water arrives | Fresh tank level and suction-side valve position | No supply, lost prime or inlet air leak |
| Pump runs and flow is weak | Inlet strainer and faucet aerators | Restriction or partial blockage |
| Pump cycles with every faucet closed | Visible leaks and pressure-side fittings | Pressure loss or check-valve issue |
| Pump does not run at all | Fuse, switch and 12V supply | Electrical issue or failed motor |
| Pump sounds different than normal | Water supply and mounting condition | Cavitation, air ingestion or mechanical wear |
| Flow pulses rapidly | Air in the system or restricted inlet | Suction-side problem or accumulator issue |

:::cta Want to compare this symptom with other water-system problems? | Open the Plumbing hub to see related troubleshooting and maintenance guides before replacing a component. | Browse Plumbing Guides | /category/plumbing

## 1. Confirm the fresh-water supply

Before touching the pump, verify the most basic condition: **does the pump have water available to draw?**

It is surprisingly easy to diagnose a pump problem when the real issue is an empty or nearly empty tank. Tank level indicators are useful, but they can also be inaccurate because of dirty probes, sensor faults or calibration problems.

Check the following:

- Confirm the fresh-water tank has enough water for testing.
- If possible, visually verify the tank level instead of relying only on the monitor panel.
- Make sure you are not connected to city water while expecting the pump to draw from the tank.
- Confirm the tank drain valve is closed.
- Confirm any tank-selection valve is pointing to the correct source.

A pump that is running dry for extended periods can overheat or wear internal components, so do not let it run indefinitely while you troubleshoot.

## 2. Check the winterization and bypass valves

Many RVs have a winterization hose or valve that allows antifreeze to be drawn directly into the plumbing system. If this valve is left in the wrong position after de-winterizing, the pump may pull air instead of water.

Typical symptoms include:

- Pump runs continuously.
- Little or no water reaches the faucets.
- The pump sounds faster or higher-pitched than normal.
- Air may spit from the faucet.

Trace the suction line from the tank toward the pump. If your RV has a winterization tee or selector valve, confirm that the line from the fresh tank is open and the winterization pickup is closed.

### Why this causes confusing symptoms

The pump does not know whether it is pulling water or air. It simply continues trying to create pressure. If the suction side is open to air, the pump may run normally but never build enough pressure to shut off.

## 3. Inspect and clean the inlet strainer

Most RV water pumps have a small transparent or semi-transparent strainer on the inlet side. Its job is to catch debris before it enters the pump.

A partially clogged strainer can cause:

- weak flow,
- pulsing water,
- noisy pump operation,
- slow pressure recovery,
- intermittent loss of prime.

Turn the pump off, relieve pressure at a faucet, then inspect the strainer bowl.

Look for:

1. sediment,
2. plastic shavings,
3. mineral debris,
4. a cracked bowl,
5. a flattened or damaged O-ring,
6. a loose threaded connection.

A dirty strainer is a restriction. A loose strainer is an air leak. Both can create similar symptoms.

![RV maintenance check visual](/demo-media/maintenance.webp "Example maintenance image showing how inline visuals can support a diagnostic section")

## 4. Look for suction-side air leaks

An RV water pump can move water effectively only if the suction side stays sealed. A very small air leak before the pump may prevent the system from priming.

Pay close attention to:

- the fitting at the fresh-water tank,
- flexible hose connections,
- the inlet strainer,
- threaded adapters,
- winterization tees,
- cracked hoses,
- loose clamps.

A suction-side air leak does not always leak water outward. Because the line is under suction while the pump is running, it may pull air inward without leaving a visible puddle.

### A useful observation

If the pump works after you manually prime the line but loses prime again after sitting, suspect an air leak or a valve that is not sealing correctly.

## 5. Open one cold-water faucet while priming

When a pump has lost prime, opening a faucet gives trapped air somewhere to escape.

Use this sequence:

1. Fill the fresh-water tank.
2. Confirm the correct valves are open.
3. Turn the pump on.
4. Open one cold-water faucet.
5. Allow the pump to run briefly while listening for a change in sound.
6. Once water flows steadily, close the faucet.
7. Confirm the pump builds pressure and shuts off.

Do not keep the pump running for a long period if it never begins moving water.

## Diagnostic checkpoint

At this stage, you should know whether the problem is likely on the **water-supply side** or whether you need to continue toward the electrical and pressure-control checks.

| Check | Pass condition | If it fails |
|---|---|---|
| Fresh tank | Water is definitely available | Fill tank and retest |
| Tank valve | Fully open | Correct valve position |
| Winterization valve | Tank line selected | Reset valve |
| Inlet strainer | Clean and sealed | Clean/reseat/replace |
| Suction hose | No visible damage or loose fittings | Repair leak |
| Priming test | Pump begins delivering water | Continue diagnosis if no change |

:::cta Still no water after the basic checks? | Move to the electrical and pump-condition checks below rather than replacing the pump immediately. | Continue the diagnosis | #electrical-checks

## 6. Separate plumbing problems from 12V electrical problems

<a id="electrical-checks"></a>

If the pump does not run at all, the diagnostic path changes. Now you need to confirm that the pump is actually receiving the power it needs.

RV water pumps are typically part of the 12V DC system. A weak connection, blown fuse, faulty switch, ground problem or low system voltage can prevent the pump from operating correctly.

![RV 12V electrical system illustration](/demo-media/electrical.webp "Example electrical-system image used to demonstrate a cross-system diagnostic section")

Before working around wiring, make sure you understand the system and can work safely.

Check:

- pump fuse,
- pump switch,
- visible connectors,
- ground connection,
- battery or converter condition,
- voltage at the pump if you have the appropriate meter and experience.

For more 12V-specific troubleshooting, use the [Electrical & 12V guides](/category/electrical).

### Pump does not make any sound

If you press the pump switch and hear absolutely nothing, possibilities include:

- no 12V supply,
- blown fuse,
- failed switch,
- loose connector,
- poor ground,
- failed pressure switch,
- failed motor.

### Pump clicks but does not run normally

A click or brief movement can point toward low voltage, a poor connection or an internal mechanical problem.

Do not assume the motor is failed until the supply voltage and connections have been checked.

## 7. Diagnose a pump that runs continuously

A healthy pressure pump should shut off after the plumbing system reaches its target pressure.

If it runs continuously, one of several conditions may exist:

- the pump cannot draw enough water,
- air is entering the suction side,
- a faucet or fixture is open,
- there is a plumbing leak,
- the pump's internal check valve is not sealing,
- the pump is worn and cannot build shutoff pressure.

First confirm that water is actually reaching the fixtures. A pump that runs continuously **with no water flow** points you back toward supply, prime or suction issues.

A pump that runs continuously **while water flows normally** may be unable to reach shutoff pressure.

## 8. Diagnose cycling when no faucet is open

If the pump runs for a few seconds every several minutes even when nobody is using water, the system is losing pressure somewhere.

Common causes include:

- dripping faucet,
- toilet valve seepage,
- exterior shower leak,
- water-heater connection leak,
- loose fitting,
- pump check valve allowing pressure to bleed backward.

### Simple isolation test

Turn the pump on and let it pressurize the system. After it shuts off, do not use any fixture.

Listen for the pump.

If it restarts on its own, pressure is being lost. Inspect the plumbing system carefully before blaming the pump.

## 9. Diagnose weak or pulsing flow

Weak flow does not automatically mean the pump is worn out.

Check restrictions first:

- clogged faucet aerator,
- partially closed valve,
- dirty inlet strainer,
- kinked hose,
- low tank level,
- air entering the inlet line.

If weak flow occurs at only one fixture, the problem is probably local to that fixture.

If it occurs everywhere, look farther upstream.

## 10. Listen to the sound of the pump

Pump sound is useful diagnostic information.

A smooth, steady sound with no water usually suggests the pump is spinning but cannot establish supply or prime.

A harsh, irregular sound may indicate air ingestion, cavitation, vibration or mechanical wear.

A pump that suddenly becomes louder after years of normal use deserves a physical inspection of:

- mounting screws,
- rubber isolation feet,
- nearby hoses,
- loose panels,
- pump head condition.

Sometimes the pump is healthy but its mounting transfers vibration into the RV structure.

## 11. Inspect the pressure side for leaks

Once you know the pump is drawing water correctly, inspect the pressure side.

Use a flashlight and check accessible fittings around:

- pump outlet,
- water heater,
- toilet,
- sinks,
- shower,
- exterior shower,
- filter housings,
- low-point drains.

A slow leak may not create a large puddle immediately. Look for damp surfaces, staining and water tracks.

## 12. Understand when an accumulator matters

Some RV plumbing systems use an accumulator tank to smooth pump cycling and reduce pressure fluctuations.

A failed or incorrectly charged accumulator can contribute to:

- rapid cycling,
- uneven flow,
- pressure swings.

However, not every RV has an accumulator. Do not diagnose or replace one unless your system actually uses it.

## 13. Check the pump's built-in pressure switch

The pressure switch tells the pump when to start and stop.

Possible pressure-switch symptoms include:

- pump does not start even though power is available,
- pump does not shut off,
- erratic cycling.

Pressure-switch adjustment or internal repair depends on the specific pump model. Follow the pump manufacturer's documentation rather than applying a generic adjustment.

## 14. Decide whether the pump is actually worn out

After the supply, suction, electrical and pressure-side conditions have been checked, the pump itself becomes a more likely cause.

Replacement may be reasonable when:

- the motor is receiving correct power but will not run,
- the pump cannot build normal pressure despite a confirmed water supply,
- internal components are visibly damaged,
- the pump leaks from its housing,
- manufacturer-approved service steps do not restore operation.

### Do not replace the pump just because it is noisy

Noise alone is not enough evidence. A loose mount, rigid hose touching a wall or air in the suction line can make a healthy pump sound much worse than normal.

## 15. Final retest after any repair

After correcting a problem, test the whole system instead of checking only the original symptom.

A useful final test is:

1. Fill the tank sufficiently.
2. Turn on the pump.
3. Run cold water at one faucet.
4. Run hot water after confirming the water heater is properly filled.
5. Close all fixtures.
6. Confirm the pump stops.
7. Wait several minutes.
8. Confirm it does not cycle unexpectedly.
9. Inspect repaired connections for leaks.

## Symptom-to-action summary

| What the RV is doing | Most useful next step |
|---|---|
| Pump runs, no water | Check tank, valves, prime, strainer and inlet leaks |
| Pump will not run | Check 12V fuse, switch, connections and voltage |
| Pump cycles by itself | Search for pressure-side leak or check-valve problem |
| Flow is weak everywhere | Check inlet restriction, tank supply and air leak |
| Flow is weak at one faucet | Inspect that fixture or aerator |
| Pump becomes unusually loud | Check air ingestion, mounting and mechanical condition |
| Pump never reaches shutoff | Check pressure leaks and pump output |

## Preventive maintenance that reduces pump problems

A few maintenance habits can prevent many of the issues above.

- Keep the inlet strainer clean.
- Do not allow the pump to run dry for long periods.
- Inspect flexible hoses and fittings during seasonal maintenance.
- Winterize and de-winterize valves carefully.
- Address small leaks before they become pressure-loss problems.
- Keep battery and converter systems healthy.

Continue with the [Maintenance section](/category/maintenance) for broader preventive work.

## Frequently asked questions

### Can an RV water pump run but still be bad?

Yes. A motor can run while the pump head is worn, damaged or unable to create sufficient pressure. But supply-side problems and air leaks should be eliminated first.

### Why does my RV water pump run but no water comes out?

The most common diagnostic directions include an empty tank, incorrect valve position, lost prime, clogged inlet strainer or suction-side air leak.

### Should I replace the pump if it keeps cycling?

Not immediately. Cycling usually means the plumbing system is losing pressure. Check fixtures, fittings and the pump check valve before replacing the entire pump.

### How long should I let the pump run while trying to prime it?

Only briefly. If the pump does not begin moving water after basic priming checks, turn it off and continue diagnosing the supply side rather than letting it run dry indefinitely.

### Can low battery voltage affect the water pump?

Yes. A 12V pump can behave abnormally if voltage is too low or if there is excessive resistance in the circuit. Use the [Electrical & 12V section](/category/electrical) if the problem appears electrical.

:::cta Not sure what to check next? | Use the RVFixWise guide library to continue by system or symptom instead of replacing parts by guesswork. | Browse all RV guides | /guides

## Final takeaway

The fastest route to a correct water-pump diagnosis is to work from the outside of the system inward.

Start with water availability and valve position. Then check the strainer, suction line and prime. If the pump does not run, move to the 12V supply. If it runs and moves water but cannot hold pressure, inspect the pressure side and check valve.

Only after those conditions are verified should the pump itself become the main replacement candidate.

That approach is slower than immediately buying a new component, but it is usually faster than replacing a good pump and discovering that the original problem is still there.
$md$,
    '/demo-media/plumbing.webp',
    'RV plumbing and water pump system illustration',
    false,
    now(),
    now()
  )
  on conflict (site_id,slug) do update set
    category_id=excluded.category_id,
    title=excluded.title,
    content_type=excluded.content_type,
    status='published',
    primary_keyword=excluded.primary_keyword,
    search_intent=excluded.search_intent,
    excerpt=excluded.excerpt,
    seo_title=excluded.seo_title,
    meta_description=excluded.meta_description,
    canonical_path=excluded.canonical_path,
    content_markdown=excluded.content_markdown,
    featured_image_url=excluded.featured_image_url,
    featured_image_alt=excluded.featured_image_alt,
    reviewer_required=false,
    published_at=coalesce(public.articles.published_at,now()),
    first_published_at=coalesce(public.articles.first_published_at,now()),
    updated_at=now()
  returning id into v_article;

  delete from public.internal_links where source_article_id=v_article;

  insert into public.internal_links (
    site_id,
    source_article_id,
    anchor_text,
    target_path
  )
  values
    (v_site,v_article,'Plumbing guides','/category/plumbing'),
    (v_site,v_article,'Electrical & 12V guides','/category/electrical'),
    (v_site,v_article,'Maintenance section','/category/maintenance'),
    (v_site,v_article,'RVFixWise guide library','/guides');
end $$;
