import type { Scenario } from "./scenario";

// Debugger provides a mechanism for stepping through a scenario, exposing UI elements and calling out to resolve state.
export class Debugger {
    private index: number;
    private eventIdOrdering: string[];
    private currentEventId: string;

    constructor(readonly scenario: Scenario) {
        this.index = -1; // so when you hit next() we load to the first event.
        this.eventIdOrdering = scenario.events.map((ev) => ev.event_id);
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
}
