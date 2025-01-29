import type { Scenario } from "./scenario";

/**
 * Print debug statistics about the provided auth DAG room.
 * This currently prints to the console, but could be represented in a prettier format e.g grafana style.
 *  - The maximum number of prev_auth_events on a single event.
 *  - The histogram and CDF of prev_auth_events counts (1,2,3,4,5,6,7,8,9,10,15,20,50)
 *  - Whether the auth DAG is connected (all prev_auth_events are known)
 * @param scenario The scenario with events to analyse
 */
export function printAuthDagAnalysis(scenario: Scenario) {
    // we tag all buckets <= prev_auth_events.length for the CDF
    // we tag the exact bucket for the histogram
    const buckets = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 50, Number.POSITIVE_INFINITY];
    const cdf = new Map<number, number>(buckets.map((val) => [val, 0]));
    const histogram = new Map<number, number>(buckets.map((val) => [val, 0]));
    let maxPrevAuthEvents = 0;
    const allEvents = new Set<string>();
    const allPrevAuthEvents = new Set<string>();
    for (const ev of scenario.events) {
        allEvents.add(ev.event_id);
        if (ev.prev_auth_events === undefined) {
            // every event must have this
            console.error(`printAuthDagAnalysis: event ${ev.event_id} has no prev_auth_events. Bailing.`);
            return;
        }
        if (ev.prev_auth_events.length > maxPrevAuthEvents) {
            maxPrevAuthEvents = ev.prev_auth_events.length;
        }
        if (ev.prev_auth_events.length === 0) {
            continue; // create event
        }
        for (const pae of ev.prev_auth_events) {
            allPrevAuthEvents.add(pae);
        }
        // snap ev.prev_auth_events.length to a bucket
        let highestBucket = ev.prev_auth_events.length;
        if (ev.prev_auth_events.length > 10) {
            // <= 10 can use the exact number
            if (ev.prev_auth_events.length <= 15) {
                highestBucket = 15;
            } else if (ev.prev_auth_events.length <= 20) {
                highestBucket = 20;
            } else if (ev.prev_auth_events.length <= 50) {
                highestBucket = 50;
            } else {
                highestBucket = Number.POSITIVE_INFINITY;
            }
        }
        histogram.set(highestBucket, (histogram.get(highestBucket) || 0) + 1);
        for (const bucket of buckets) {
            if (bucket > highestBucket) {
                break; // buckets are sorted so when we go beyond the highest val we can bail
            }
            cdf.set(bucket, (cdf.get(bucket) || 0) + 1);
        }
    }

    const s = ["Auth DAG Analysis:", `Max prev_auth_events: ${maxPrevAuthEvents}`, "Histogram:"];
    histogram.forEach((val, key) => {
        s.push(`${key} ${val}`);
    });
    s.push("CDF:");
    cdf.forEach((val, key) => {
        s.push(`${key} ${val}`);
    });
    // the graph is connected if we have the events for all known prev_auth_events, in other words
    // prev_auth_events is a subset of allEvents. isSubsetOf is a 2024 thing.
    const isConnected = allPrevAuthEvents.isSubsetOf(allEvents);
    s.push(`Connected: ${isConnected}`);
    console.log(s.join("\n"));
}
