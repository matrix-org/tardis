import type { ScenarioFile } from "./scenario";

const quickstartFile: ScenarioFile = {
    calculate_event_ids: true,
    on_load_at_start: true,
    events: [
        {
            type: "m.room.create",
            state_key: "",
            sender: "@creator:tardis",
            auth_events: [],
            prev_events: [],
            content: { creator: "@creator:tardis" },
            event_id: "$CREATE",
        },
        {
            type: "m.room.member",
            state_key: "@creator:tardis",
            sender: "@creator:tardis",
            auth_events: ["$CREATE"],
            prev_events: ["$CREATE"],
            content: { membership: "join" },
            event_id: "$JOIN",
        },
        {
            type: "m.room.message",
            sender: "@creator:tardis",
            auth_events: ["$CREATE", "$JOIN"],
            prev_events: ["$JOIN"],
            content: { body: "A wild fork appears!" },
            event_id: "$FORK1",
        },
        {
            type: "m.room.message",
            sender: "@creator:tardis",
            auth_events: ["$CREATE", "$JOIN"],
            prev_events: ["$JOIN"],
            content: { body: "Another wild fork appears!" },
            event_id: "$FORK2",
        },
        {
            type: "m.room.message",
            sender: "@creator:tardis",
            auth_events: ["$CREATE", "$JOIN"],
            prev_events: ["$FORK1", "$FORK2"],
            content: { body: "Merged!" },
            event_id: "$MERGE",
        },
        {
            type: "m.room.message",
            sender: "@creator:tardis",
            auth_events: ["$CREATE", "$JOIN"],
            prev_events: ["$MERGE"],
            content: { body: "This event has precalculated state" },
            event_id: "$PRESTATE",
        },
        {
            type: "m.room.name",
            state_key: "",
            sender: "@creator:tardis",
            auth_events: ["$CREATE", "$JOIN"],
            prev_events: ["$PRESTATE"],
            content: { name: "State events are blue, messages are grey" },
            event_id: "$MSG",
        },
        {
            type: "m.room.message",
            sender: "@creator:tardis",
            auth_events: ["$CREATE", "$JOIN"],
            prev_events: ["$MSG"],
            content: { body: "Boring long chains..." },
            event_id: "$MSG2",
        },
        {
            type: "m.room.message",
            sender: "@creator:tardis",
            auth_events: ["$CREATE", "$JOIN"],
            prev_events: ["$MSG2"],
            content: { body: "...can be collapsed..." },
            event_id: "$MSG3",
        },
        {
            type: "m.room.message",
            sender: "@creator:tardis",
            auth_events: ["$CREATE", "$JOIN"],
            prev_events: ["$MSG3"],
            content: { body: "...by checking the collapse checkbox." },
            event_id: "$MSG4",
        },
    ],
    room_id: "!quickstart:tardis",
    room_version: "10",
    tardis_version: 1,
    annotations: {
        title: ["Welcome to TARDIS! Press the → button to continue."].join("\n"),
        titles: {
            $FORK1: "State events are highlighted in blue. Messages are highlighted in grey.",
            $FORK2: "The DAG can fork, which indicates some events were sent at the same time.",
            $MERGE: "The DAG can merge, which merges state from each fork together. This is state resolution.",
            $PRESTATE: "Green events indicate the state at this event. Message events will never be green.",
            $MSG: "Check the 'Auth Chain' box to show the `auth_events` for each event.",
            $MSG2: "Press the 'Resolve State' button to calculate which events are part of the current room state.",
            $MSG3: [
                "As state resolution is iterative, it will resolve state for all earlier events as well.",
                "Click on an earlier event in the list to jump to that event.",
            ].join("\n"),
            $MSG4: [
                "Now load a file or use one of the pre-loaded files to experiment with state resolution in Matrix!",
            ].join("\n"),
        },
        events: {
            $MSG: "Blue nodes like this one are state events.",
            $MSG2: "Boring long chains...",
            $MSG3: "...can be collapsed...",
            $MSG4: "...by checking the collapse checkbox.",
            $PRESTATE: "This event has pre-calculated state (in green) after this event",
        },
    },
    precalculated_state_after: {
        $PRESTATE: ["$CREATE", "$JOIN"],
    },
};

const mainlineForks: ScenarioFile = {
    calculate_event_ids: true,
    on_load_at_start: true,
    events: [
        {
            type: "m.room.create",
            state_key: "",
            sender: "@alice:tardis",
            auth_events: [],
            prev_events: [],
            content: { creator: "@alice:tardis" },
            event_id: "$CREATE",
        },
        {
            type: "m.room.member",
            state_key: "@alice:tardis",
            sender: "@alice:tardis",
            auth_events: ["$CREATE"],
            prev_events: ["$CREATE"],
            content: { membership: "join" },
            event_id: "$ALICE",
        },
        {
            type: "m.room.power_levels",
            state_key: "",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE"],
            prev_events: ["$ALICE"],
            content: { users: { "@alice:tardis": 100 }, events: { "m.room.name": 50 }, users_default: 50 },
            event_id: "$PL",
        },
        {
            type: "m.room.join_rules",
            state_key: "",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL"],
            prev_events: ["$PL"],
            content: { join_rule: "public" },
            event_id: "$JR",
        },
        {
            type: "m.room.member",
            state_key: "@bob:tardis",
            sender: "@bob:tardis",
            auth_events: ["$CREATE", "$JR", "$PL"],
            prev_events: ["$JR"],
            content: { membership: "join" },
            event_id: "$BOB",
        },
        {
            type: "m.room.name",
            state_key: "",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL"],
            prev_events: ["$BOB"],
            content: { name: "Alice Room" },
            event_id: "$ALICE_NAME",
        },
        {
            type: "m.room.name",
            state_key: "",
            sender: "@bob:tardis",
            auth_events: ["$CREATE", "$BOB", "$PL"],
            prev_events: ["$BOB"],
            content: { name: "Bob Room" },
            event_id: "$BOB_NAME",
        },
        {
            type: "m.room.message",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL"],
            prev_events: ["$ALICE_NAME", "$BOB_NAME"],
            content: { body: "Bob wins." },
            event_id: "$MERGE1",
        },
        {
            type: "m.room.name",
            state_key: "",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL"],
            prev_events: ["$MERGE1"],
            content: { name: "Alice Room 2" },
            origin_server_ts: 1704067281337,
            event_id: "$ALICE_NAME2",
        },
        {
            type: "m.room.name",
            state_key: "",
            sender: "@bob:tardis",
            auth_events: ["$CREATE", "$BOB", "$PL"],
            prev_events: ["$MERGE1"],
            content: { name: "Bob Room 2" },
            origin_server_ts: 1704067281337,
            event_id: "$BOB_NAME2",
        },
        {
            type: "m.room.message",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL"],
            prev_events: ["$ALICE_NAME2", "$BOB_NAME2"],
            content: { body: "Alice wins." },
            event_id: "$MERGE2",
        },
        {
            type: "m.room.name",
            state_key: "",
            sender: "@bob:tardis",
            auth_events: ["$CREATE", "$BOB", "$PL"],
            prev_events: ["$MERGE2"],
            content: { name: "Bob Room 3" },
            origin_server_ts: 1704077300300,
            event_id: "$BOB_NAME3",
        },
        {
            type: "m.room.power_levels",
            state_key: "",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE"],
            prev_events: ["$MERGE2"],
            content: { users: { "@alice:tardis": 100 }, events: { "m.room.name": 50 }, users_default: 50 },
            event_id: "$PL2",
        },
        {
            type: "m.room.name",
            state_key: "",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL2"],
            prev_events: ["$PL2"],
            content: { name: "Alice Room 3" },
            origin_server_ts: 1704077299300,
            event_id: "$ALICE_NAME3",
        },
        {
            type: "m.room.message",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL2"],
            prev_events: ["$ALICE_NAME3", "$BOB_NAME3"],
            content: { body: "Alice wins." },
            event_id: "$MERGE3",
        },
    ],
    room_id: "!mainline-fork:tardis",
    room_version: "10",
    tardis_version: 1,
    annotations: {
        title: "The winner follows this priority: Mainline depth THEN origin_server_ts THEN event ID",
        titles: {
            $ALICE: [
                "Mainline Ordering:",
                "The conflicting state events in this example are all room name changes and hence do not restrict anyone's permissions.",
                "This makes it easier to explain. All of the merges in this example are due to 'mainline ordering'.",
            ].join("\n"),
            $MERGE1: [
                "Bob wins because his event has a higher origin_server_ts. Both events have the same mainline depth.",
            ].join("\n"),
            $MERGE2: ["Both events have the same timestamp. Alice wins with a higher event ID (A < Z < a < z)."].join(
                "\n",
            ),
            $MERGE3: [
                "Bob's event has a higher timestamp but Alice wins because her event happened AFTER a change to the power levels.",
                "This gives her event a higher 'mainline position' which is considered before the timestamp or event ID.",
            ].join("\n"),
        },
        events: {},
    },
};

const reverseTopologicalPowerOrdering: ScenarioFile = {
    calculate_event_ids: true,
    on_load_at_start: true,
    events: [
        {
            type: "m.room.create",
            state_key: "",
            sender: "@alice:tardis",
            auth_events: [],
            prev_events: [],
            content: { creator: "@alice:tardis" },
            event_id: "$CREATE",
        },
        {
            type: "m.room.member",
            state_key: "@alice:tardis",
            sender: "@alice:tardis",
            auth_events: ["$CREATE"],
            prev_events: ["$CREATE"],
            content: { membership: "join" },
            event_id: "$ALICE",
        },
        {
            type: "m.room.power_levels",
            state_key: "",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE"],
            prev_events: ["$ALICE"],
            content: { users: { "@alice:tardis": 100 }, events: { "m.room.join_rules": 50 }, users_default: 50 },
            event_id: "$PL",
        },
        {
            type: "m.room.join_rules",
            state_key: "",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL"],
            prev_events: ["$PL"],
            content: { join_rule: "public" },
            event_id: "$JR",
        },
        {
            type: "m.room.member",
            state_key: "@bob:tardis",
            sender: "@bob:tardis",
            auth_events: ["$CREATE", "$JR", "$PL"],
            prev_events: ["$JR"],
            content: { membership: "join" },
            event_id: "$BOB",
        },
        {
            type: "m.room.member",
            state_key: "@charlie:tardis",
            sender: "@charlie:tardis",
            auth_events: ["$CREATE", "$JR", "$PL"],
            prev_events: ["$BOB"],
            content: { membership: "join" },
            event_id: "$CHARLIE",
        },
        {
            type: "m.room.join_rules",
            state_key: "",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL"],
            prev_events: ["$CHARLIE"],
            content: { join_rule: "invite" },
            event_id: "$ALICE_JR",
        },
        {
            type: "m.room.join_rules",
            state_key: "",
            sender: "@bob:tardis",
            auth_events: ["$CREATE", "$BOB", "$PL"],
            prev_events: ["$CHARLIE"],
            content: { join_rule: "knock" },
            event_id: "$BOB_JR",
        },
        {
            type: "m.room.message",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL"],
            prev_events: ["$ALICE_JR", "$BOB_JR"],
            content: { body: "Bob wins." },
            event_id: "$MERGE1",
        },
        {
            type: "m.room.join_rules",
            state_key: "",
            sender: "@bob:tardis",
            auth_events: ["$CREATE", "$BOB", "$PL"],
            prev_events: ["$MERGE1"],
            content: { join_rule: "knock" },
            event_id: "$BOB_JR2",
        },
        {
            type: "m.room.join_rules",
            state_key: "",
            sender: "@charlie:tardis",
            auth_events: ["$CREATE", "$CHARLIE", "$PL"],
            prev_events: ["$MERGE1"],
            content: { join_rule: "public" },
            event_id: "$CHARLIE_JR",
        },
        {
            type: "m.room.message",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL"],
            prev_events: ["$BOB_JR2", "$CHARLIE_JR"],
            content: { body: "Charlie wins." },
            event_id: "$MERGE2",
        },
        {
            type: "m.room.join_rules",
            state_key: "",
            sender: "@bob:tardis",
            auth_events: ["$CREATE", "$BOB", "$PL"],
            prev_events: ["$MERGE2"],
            content: { join_rule: "knock" },
            origin_server_ts: 1704077299001,
            event_id: "$BOB_JR3",
        },
        {
            type: "m.room.join_rules",
            state_key: "",
            sender: "@charlie:tardis",
            auth_events: ["$CREATE", "$CHARLIE", "$PL"],
            prev_events: ["$MERGE2"],
            content: { join_rule: "invite" },
            origin_server_ts: 1704077299001,
            event_id: "$CHARLIE_JR2",
        },
        {
            type: "m.room.message",
            sender: "@alice:tardis",
            auth_events: ["$CREATE", "$ALICE", "$PL"],
            prev_events: ["$CHARLIE_JR2", "$BOB_JR3"],
            content: { body: "Bob wins." },
            event_id: "$MERGE3",
        },
    ],
    room_id: "!power-ordering:tardis",
    room_version: "10",
    tardis_version: 1,
    annotations: {
        title: "The winner follows this priority: Sender Power Level THEN origin_server_ts THEN event ID",
        titles: {
            $PL: "Join rules can be modified by ANYONE",
            $ALICE: [
                "Reverse Topological Power Ordering:",
                "The conflicting state events in this example potentially restrict permissions because they are join rules.",
                "All of the merges in this example are due to this ordering.",
            ].join("\n"),
            $MERGE1: [
                "Bob's 'knock' wins because he has a lower PL (50 vs 100).",
                "This seems undesirable at first, but this can be worded another way: Alice's 'invite' is APPLIED FIRST, and then Bob's.",
                "This order ensures if Alice revokes Bob's permissions, Alice wins.",
            ].join("\n"),
            $MERGE2: [
                "Both Bob and Charlie have the same PL (50). Charlie's 'public' wins because his event has a higher origin_server_ts",
            ].join("\n"),
            $MERGE3: [
                "Both events have the same timestamp. Bob's 'knock' wins because his event ID is greater than Charlie's (A < Z < a < z)",
            ].join("\n"),
        },
        events: {},
    },
};

export { quickstartFile, mainlineForks, reverseTopologicalPowerOrdering };
