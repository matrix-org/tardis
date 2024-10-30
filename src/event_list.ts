import type { MatrixEvent } from "./state_resolver";

export class EventList {
    private highlightedEventId: string;
    private listener: (eventId: string) => void;
    constructor(
        readonly container: HTMLElement,
        readonly template: HTMLTemplateElement,
    ) {}

    clear(): void {
        this.container.innerHTML = "";
    }

    onEventClick(fn): void {
        this.listener = fn;
    }

    private onCellClick(ev) {
        const row = ev.target?.parentElement;
        if (!row) {
            return;
        }
        const eventId = row.getAttribute("id");
        if (eventId && this.listener) {
            this.listener(eventId);
        }
    }

    appendEvent(index: number, ev: MatrixEvent) {
        // https://developer.mozilla.org/en-US/docs/Web/HTML/Element/template#avoiding_documentfragment_pitfall
        const row = this.template.content.firstElementChild!.cloneNode(true) as HTMLDivElement;
        row.setAttribute("id", ev.event_id);
        const prefix = row.getElementsByClassName("eventlistrowprefix")[0];
        prefix.textContent = String(index);
        prefix.addEventListener("click", this.onCellClick.bind(this));
        row.getElementsByClassName("eventlistrowbody")[0].textContent = JSON.stringify(ev);
        this.container.appendChild(row);
    }

    highlight(eventId: string) {
        if (this.highlightedEventId) {
            const oldElement = document.getElementById(this.highlightedEventId);
            if (oldElement) {
                oldElement.style.backgroundColor = "";
                oldElement.style.fontWeight = "";
            }
        }
        document.getElementById(eventId)!.style.backgroundColor = "#6f8ea9";
        document.getElementById(eventId)!.style.fontWeight = "600";
        this.highlightedEventId = eventId;
    }
}
