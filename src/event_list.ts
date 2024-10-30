import type { MatrixEvent } from "./state_resolver";

export class EventList {
    private highlightedEventId: string;
    constructor(
        readonly container: HTMLElement,
        readonly template: HTMLTemplateElement,
    ) {}

    clear(): void {
        this.container.innerHTML = "";
    }

    appendEvent(index: number, ev: MatrixEvent) {
        // https://developer.mozilla.org/en-US/docs/Web/HTML/Element/template#avoiding_documentfragment_pitfall
        const row = this.template.content.firstElementChild!.cloneNode(true);
        row.setAttribute("id", ev.event_id);
        row.getElementsByClassName("eventlistrowprefix")[0].textContent = index;
        row.getElementsByClassName("eventlistrowbody")[0].textContent = JSON.stringify(ev);
        this.container.appendChild(row);
    }

    highlight(eventId: string) {
        if (this.highlightedEventId) {
            document.getElementById(this.highlightedEventId)!.style.backgroundColor = "";
            document.getElementById(this.highlightedEventId)!.style.fontWeight = "";
        }
        document.getElementById(eventId)!.style.backgroundColor = "#6f8ea9";
        document.getElementById(eventId)!.style.fontWeight = "600";
        this.highlightedEventId = eventId;
    }
}
