import * as d3 from "d3";
import type { MatrixEvent } from "./state_resolver";

interface RenderableMatrixEvent extends MatrixEvent {
    next_events: Array<string>;
    x: number;
    y: number;
    laneWidth: number;
}

const redraw = (vis: HTMLDivElement, events: MatrixEvent[]) => {
    // copy the events so we don't alter the caller's copy
    // biome-ignore lint/style/noParameterAssign:
    events = JSON.parse(JSON.stringify(events));
    // sort events chronologically
    const data: Array<RenderableMatrixEvent> = events; // .sort((a, b) => a.origin_server_ts - b.origin_server_ts);

    const eventsById: Map<string, RenderableMatrixEvent> = new Map();
    for (const d of data) {
        eventsById.set(d.event_id, d);
    }

    // and insert potential placeholders for dangling prev_events.
    // we slice to do a shallow copy given we're inserting placeholders into data
    for (const d of data.slice()) {
        // order parents chronologically
        d.prev_events.sort((a: string, b: string) => {
            return (eventsById.get(a)?.origin_server_ts || 0) - (eventsById.get(b)?.origin_server_ts || 0);
        });

        for (const p of d.prev_events) {
            if (!eventsById.get(p)) {
                const placeholder = {
                    event_id: p,
                    type: "dangling",
                    prev_events: [],
                    next_events: [],
                    content: {},
                    sender: "dangling",
                    auth_events: [],
                    room_id: "",
                    origin_server_ts: 0,
                };
                eventsById.set(p, placeholder);
                // insert the placeholder immediately before the event which refers to it
                const i = data.findIndex((ev) => ev.event_id === d.event_id);
                console.log("inserting placeholder prev_event at ", i);
                data.splice(i, 0, placeholder);
            }

            // update children on parents
            const parent = eventsById.get(p)!;
            if (!parent.next_events) parent.next_events = [];
            //console.log(`push ${d.event_id} onto ${parent.event_id}.next_events`);
            parent.next_events.push(d.event_id);
        }
    }

    // which lanes are in use, so we know which to fill up
    const lanes: Array<string> = [];
    const laneEnd: Array<number> = []; // the height at which this lane was terminated

    // for balanced layout:
    const laneWidth = 100;
    lanes.length = laneWidth;
    laneEnd.length = laneWidth;

    function getNextLane(after: number | null = null) {
        const balanced = false;
        if (balanced) {
            // biome-ignore lint/style/noParameterAssign:
            if (after == null) after = 0;
            // finds the next empty lane
            // if (after >= lanes.length) return after;

            let foundAfter = false;
            for (let i = 0; i < lanes.length; i++) {
                // 0, -1, 1, -2, 2, -3, 3 etc.
                let x = Math.ceil(i / 2) * (((i + 1) % 2) * 2 - 1);
                x += laneWidth / 2;
                if (after) {
                    if (after === x) {
                        foundAfter = true;
                        continue;
                    }
                    if (!foundAfter) continue;
                }
                if (!lanes[x]) return x;
            }
        } else {
            const startingAt = after == null ? 0 : after + 1;
            // finds the next empty lane
            if (startingAt >= lanes.length) return startingAt;

            for (let i = startingAt; i < lanes.length; i++) {
                if (!lanes[i]) return i;
            }

            return lanes.length;
        }
    }

    let y = 0;
    data[0].x = 0;
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        console.log(
            y,
            d.event_id.slice(0, 5),
            d.sender,
            d.type,
            lanes.map((id) => id?.substr(0, 5)).join(", "),
            `p:${d.prev_events.map((id) => id.substr(0, 5)).join(", ")}`,
            `n:${d.next_events?.map((id) => id.substr(0, 5)).join(", ")}`,
        );

        d.y = y;
        y++;

        // if any of my parents has a lane, position me under it, preferring the oldest
        let foundLane = false;
        for (const p of d.prev_events) {
            const parent = eventsById.get(p);
            if (lanes.findIndex((id) => id === parent.event_id) !== -1) {
                d.x = parent.x;
                foundLane = true;
            }
            break;
        }

        // otherwise, start a new lane
        if (!foundLane) {
            // don't re-use lanes if you have prev_events higher than the end of the lane
            // otherwise you'll overlap them.
            d.x = getNextLane();
            if (d.prev_events && eventsById.get(d.prev_events[0])) {
                const oldestPrevEventY = eventsById.get(d.prev_events[0]).y;
                while (laneEnd[d.x] !== undefined && oldestPrevEventY < laneEnd[d.x]) {
                    d.x = getNextLane(d.x);
                }
            }
        }

        // if am not the oldest parent of any of my children, terminate this lane,
        // as they will never try to position themselves under me.
        let oldestParent = false;
        if (d.next_events) {
            for (const c of d.next_events) {
                const child = eventsById.get(c);
                if (child.prev_events[0] === d.event_id) {
                    oldestParent = true;
                    break;
                }
            }
        }

        if (oldestParent) {
            // label this lane with my id for the benefit of whatever child
            // will go under it, to stop other nodes grabbing it
            lanes[d.x] = d.event_id;
        } else {
            console.log(`terminating lane ${d.x}`);
            delete lanes[d.x];
            laneEnd[d.x] = y;
        }
    }

    // another pass to figure out the right-hand edge
    const edges: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        while (edges.length > 0 && i > edges.at(-1)?.y) edges.pop();
        if (d.next_events) {
            edges.push({
                x: eventsById.get(d.next_events.at(-1)).x,
                y: eventsById.get(d.next_events.at(-1)).y,
            });
        }
        edges.sort((a, b) => a.x - b.x);
        d.laneWidth = edges.at(-1)?.x;
    }

    const margin = {
        top: 20,
        right: 20,
        bottom: 30,
        left: 140,
    };

    //
    // Drawing operations below
    //
    const g = 20; // grid spacing
    const r = 5; // node size

    const prevColor = "#f00";
    const currColor = "#0a0";
    const nextColor = "#00f";

    // empty vis div
    d3.select(vis).html(null);

    // determine width & height of parent element and subtract the margin
    const width = lanes.length * g + 1000;
    const height = data.length * g;

    // create svg and create a group inside that is moved by means of margin
    const svg = d3
        .select(vis)
        .append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${[margin.left, margin.top]})`);

    const node = svg
        .append("g")
        .selectAll("circle")
        .data(data)
        .enter()
        .append("g")
        .attr("class", (d) => `node-${d.event_id.substr(1, 6)}`)
        .on("mouseover", function (e, d) {
            const node = d3.select(this);
            node.raise().attr("fill", currColor).attr("font-weight", "bold");

            // next-events
            node.select(`.child-${d.event_id.substr(1, 6)}`)
                .attr("stroke", nextColor)
                .attr("stroke-width", "3");

            for (const id of d.next_events) {
                d3.select(`.node-${id.substr(1, 6)}`).attr("fill", nextColor);
            }

            // draw the prev-events over the top
            // because we don't have a way to select prev-events
            // (given next-events are drawn en masse)
            node.append("path")
                .attr("d", (d) => {
                    const path = d3.path();
                    if (d.prev_events) {
                        for (const parent of d.prev_events) {
                            const p = eventsById.get(parent);
                            path.moveTo(p.x * g, p.y * g + r);
                            path.arcTo(p.x * g, (p.y + 0.5) * g, d.x * g, (p.y + 0.5) * g, r);
                            path.arcTo(d.x * g, (p.y + 0.5) * g, d.x * g, d.y * g - r, r);
                            path.lineTo(d.x * g, d.y * g - r);

                            // arrowhead
                            path.moveTo(p.x * g - r / 3, p.y * g + r + r / 2);
                            path.lineTo(p.x * g, p.y * g + r);
                            path.lineTo(p.x * g + r / 3, p.y * g + r + r / 2);
                            path.lineTo(p.x * g - r / 3, p.y * g + r + r / 2);
                            path.lineTo(p.x * g, p.y * g + r);
                        }
                    }

                    return path;
                })
                .attr("stroke", prevColor)
                .attr("stroke-width", "3")
                .attr("fill", "none");

            for (const id of d.prev_events) {
                d3.select(`.node-${id.substr(1, 6)}`).attr("fill", prevColor);
            }
        })
        .on("mouseout", function (e, d) {
            d3.select(this)
                .attr("fill", null)
                .attr("font-weight", null)
                // remove prev-events
                .select(":last-child")
                .remove();

            for (const id of d.prev_events) {
                d3.select(`.node-${id.substr(1, 6)}`).attr("fill", null);
            }
            for (const id of d.next_events) {
                d3.select(`.node-${id.substr(1, 6)}`).attr("fill", null);
            }

            node.select(`.child-${d.event_id.substr(1, 6)}`)
                .attr("stroke", "black")
                .attr("stroke-width", "1");
        });

    // draw data points
    node.append("circle")
        .attr("cx", (d) => d.x * g)
        .attr("cy", (d) => d.y * g)
        .attr("r", r)
        .style("fill", (d) => (d.state_key ? "#4300ff" : "#ff3e00"))
        .style("fill-opacity", "0.5")
        .style("stroke", (d) => (d.state_key ? "#4300ff" : "#ff3e00"));

    const nudgeOffset = 4;

    if (!nudgeOffset) {
        node.append("path")
            .attr("d", (d) => {
                const path = d3.path();
                if (d.next_events) {
                    for (const child of d.next_events) {
                        const c = eventsById.get(child);
                        path.moveTo(d.x * g, d.y * g + r);
                        path.arcTo(d.x * g, (d.y + 0.5) * g, c.x * g, (d.y + 0.5) * g, r);
                        path.arcTo(c.x * g, (d.y + 0.5) * g, c.x * g, c.y * g - r, r);
                        path.lineTo(c.x * g, c.y * g - r);
                    }
                }

                return path;
            })
            .attr("stroke", "white")
            .attr("stroke-width", "2")
            .attr("fill", "none");
    }

    node.append("path")
        .attr("d", (d) => {
            const path = d3.path();
            if (d.next_events) {
                let childIndex = 0;
                for (const child of d.next_events) {
                    const c = eventsById.get(child);

                    let nudge_x = 0;
                    let nudge_y = 0;

                    if (nudgeOffset) {
                        // nudge horizontal up or down based on how many next_events there are from this node.
                        nudge_y =
                            d.next_events.length > 1 ? nudgeOffset * (childIndex - (d.next_events.length - 2) / 2) : 0;
                        // nudge vertical left or right based on how many prev_events there are from this child.
                        const childParentIndex = c.prev_events.findIndex((id) => id === d.event_id);
                        nudge_x = nudgeOffset * (childParentIndex - (c.prev_events.length - 1) / 2);
                    }

                    path.moveTo(d.x * g, d.y * g + r + nudge_y);

                    // path.lineTo(c.x * g, d.y * g);
                    // path.lineTo(c.x * g, c.y * g);
                    // path.quadraticCurveTo(c.x * g, d.y * g, c.x * g, c.y * g);

                    // path.arcTo(c.x * g, d.y * g, c.x * g, c.y * g, g/2);
                    // path.lineTo(c.x * g, c.y * g);

                    if (nudgeOffset) {
                        path.lineTo(d.x * g, (d.y + 0.5) * g + nudge_y);
                        path.lineTo(c.x * g + nudge_x, (d.y + 0.5) * g + nudge_y);
                    } else {
                        path.arcTo(d.x * g, (d.y + 0.5) * g, c.x * g, (d.y + 0.5) * g, r);
                        path.arcTo(c.x * g, (d.y + 0.5) * g, c.x * g, c.y * g - r, r);
                    }

                    path.lineTo(c.x * g + nudge_x, c.y * g - r);

                    childIndex++;
                }
            }

            // arrowhead
            path.moveTo(d.x * g - r / 3, d.y * g + r + r / 2);
            path.lineTo(d.x * g, d.y * g + r);
            path.lineTo(d.x * g + r / 3, d.y * g + r + r / 2);
            path.lineTo(d.x * g - r / 3, d.y * g + r + r / 2);
            path.lineTo(d.x * g, d.y * g + r);

            return path;
        })
        .attr("class", (d) => `child-${d.event_id.substr(1, 6)}`)
        .attr("stroke", "black")
        .attr("fill", "none");

    node.append("text")
        .text(
            (d) =>
                `${d.y} ${d.event_id.substr(0, 5)} ${d.sender} P:${d.prev_events.map((id) => id.substr(0, 5)).join(", ")} | N:${d.next_events?.map((id) => id.substr(0, 5)).join(", ")}`,
        )
        //.text(d => `${d.y} ${d.event_id.substr(0, 5)} ${d.sender} ${d.type} prev:${d.prev_events.map(id => id.substr(0, 5)).join(", ")}`)
        .attr("x", (d) => d.laneWidth * g + 14)
        .attr("y", (d) => d.y * g + 4);

    node.append("text")
        .text((d) => (d.origin_server_ts ? new Date(d.origin_server_ts).toLocaleString() : ""))
        .attr("x", -140)
        .attr("y", (d) => d.y * g + 4);
};

export { redraw };
