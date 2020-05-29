## TARDIS - Time Agnostic Room DAG Inspection Service

TARDIS is a time-travelling debugger for Matrix room DAGs, which hooks into
Dendrite's internal APIs to graphically visualise a room using [d3-dag](https://github.com/erikbrinkman/d3-dag) for
debugging purposes.

The intention is to add it as a RightPanel widget to Riot (particularly in p2p mode)
to help figure out what's gone wrong if your P2P node goes weird.

It's effectively the real-life version of the 2014-vintage D3 "how matrix
works" animation from the frontpage of Matrix.org.

Currently very experimental and PoC.

## Generates stuff like this:

![](img/sugiyama.png)

![](img/zherebko.png)

### To use:

Apply a minimal debugging patch to your dendrite's gomatrixserverlib:

```patch
diff --git a/event.go b/event.go
index f0564fe..05ed845 100644
--- a/event.go
+++ b/event.go
@@ -1010,6 +1010,7 @@ func (e Event) Headered(roomVersion RoomVersion) HeaderedEvent {
        return HeaderedEvent{
                EventHeader: EventHeader{
                        RoomVersion: roomVersion,
+                       DebugEventID: e.EventID(),
                },
                Event: e,
        }
diff --git a/headeredevent.go b/headeredevent.go
index 414230c..c711436 100644
--- a/headeredevent.go
+++ b/headeredevent.go
@@ -13,10 +13,15 @@ import (
 // this struct must have a "json:" name tag or otherwise the reflection
 // code for marshalling and unmarshalling headered events will not work.
 // They must be unique and not overlap with a name tag from the Event
-// struct or otherwise panics may occur, so header  name tags are instead
+// struct or otherwise panics may occur, so header name tags are instead
 // prefixed with an underscore.
 type EventHeader struct {
        RoomVersion RoomVersion `json:"_room_version,omitempty"`
+
+       // This is needed because otherwise Room V3+ events don't
+       // marshal an explicit EventID into their JSON, which makes debugging
+       // hard for things like TARDIS timetravel debugging.
+       DebugEventID string     `json:"_event_id,omitempty"`
 }
 
 // HeaderedEvent is a wrapper around an Event that contains information
```

And then to run it, tweak the config in src/index.js, and:

```
yarn install
yarn run start
```
