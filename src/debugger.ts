import type { Cache } from "./cache";
import type { Scenario } from "./scenario";
import type { EventID, MatrixEvent, StateKeyTuple } from "./state_resolver";

// Debugger provides a mechanism for stepping through a scenario, exposing UI elements and calling out to resolve state.
export class Debugger {
    private index: number;
    private eventIdOrdering: string[];
    private currentEventId: string;

    constructor(readonly scenario: Scenario) {
        this.index = scenario.events.length - 1; // last event
        this.eventIdOrdering = scenario.events.map((ev) => ev.event_id);
        this.currentEventId = this.eventIdOrdering[this.index];
    }

    next() {
        this.index++;
        if (this.index >= this.eventIdOrdering.length) {
            this.index = this.eventIdOrdering.length - 1;
        }
        this.currentEventId = this.eventIdOrdering[this.index];
    }
    previous() {
        this.index--;
        if (this.index < 0) {
            this.index = 0;
        }
        this.currentEventId = this.eventIdOrdering[this.index];
    }
    goTo(eventId: string) {
        for (let i = 0; i < this.eventIdOrdering.length; i++) {
            if (this.eventIdOrdering[i] === eventId) {
                this.index = i;
                this.currentEventId = this.eventIdOrdering[this.index];
                break;
            }
        }
    }
    current(): string {
        return this.currentEventId;
    }
    eventsUpToCurrent(): string[] {
        const eventIds: string[] = [];
        for (let i = 0; i <= this.index; i++) {
            eventIds.push(this.eventIdOrdering[i]);
        }
        return eventIds;
    }

    // Perform state resolution at the current step.
    // Stores results in the cache via cache.stateAtEvent.setState
    // Pulls events from the cache via cache.eventCache.get
    // Calls the callback to perform state resolution on a set of states.
    async resolve(
        cache: Cache,
        resolveState: (
            roomId: string,
            roomVer: string,
            states: Array<Record<StateKeyTuple, EventID>>,
            atEvent: MatrixEvent,
        ) => Promise<Record<StateKeyTuple, EventID>>,
    ): Promise<void> {
        // we don't just resolve the current step, but resolve all steps up to and including the current
        // step. If we've done it before then it will no-op. We need to do this as to work out the state
        // at event N we need to know the state at event N-1.
        for (const oldEventId of this.eventsUpToCurrent()) {
            await this.resolveEvent(oldEventId, cache, resolveState);
        }
    }

    private async resolveEvent(
        atEventId: string,
        cache: Cache,
        resolveState: (
            roomId: string,
            roomVer: string,
            states: Array<Record<StateKeyTuple, EventID>>,
            atEvent: MatrixEvent,
        ) => Promise<Record<StateKeyTuple, EventID>>,
    ): Promise<void> {
        if (cache.stateAtEvent.getStateAsEventIds(atEventId).size > 0) {
            return; // we've already worked out the state at this event.
        }
        const atEvent = cache.eventCache.get(atEventId)!;
        // we need to do state resolution.
        const states: Array<Record<StateKeyTuple, EventID>> = [];
        for (const prevEventId of atEvent.prev_events) {
            const prevState = cache.stateAtEvent.getState(prevEventId);
            if (Object.keys(prevState).length === 0) {
                console.error(
                    `WARN: we do not know the state at ${prevEventId} yet, so the state calculation for ${atEventId} may be wrong!`,
                );
            }
            states.push(prevState);
        }
        console.log("performing state resolution for prev_events:", atEvent.prev_events);
        const theState = await resolveState(atEvent.room_id, this.scenario.roomVersion, states, atEvent);
        cache.stateAtEvent.setState(atEventId, theState);
    }
}
