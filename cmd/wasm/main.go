// Includes functions useful for tardis, written in Go.
// Compiled using TinyGo to keep .wasm file sizes small.
package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"syscall/js"

	"github.com/matrix-org/gomatrixserverlib"
	"github.com/matrix-org/gomatrixserverlib/spec"
)

// This function is exported to JS, and returns the event ID for the input event JSON and
// room version using the same code paths as Dendrite.
func eventIDForEvent(this js.Value, args []js.Value) any {
	if len(args) != 2 {
		fmt.Println("eventIDForEvent: must be called with (event, roomVer)")
		return ""
	}
	eventJSON := args[0].String()
	roomVerStr := args[1].String()
	roomVersion := gomatrixserverlib.RoomVersion(roomVerStr)
	verImpl, err := gomatrixserverlib.GetRoomVersion(roomVersion)
	if err != nil {
		return ""
	}
	redactedJSON, err := verImpl.RedactEventJSON([]byte(eventJSON))
	if err != nil {
		return ""
	}

	var event map[string]spec.RawJSON
	if err = json.Unmarshal(redactedJSON, &event); err != nil {
		return ""
	}

	delete(event, "signatures")
	delete(event, "unsigned")
	existingEventID := event["event_id"]
	delete(event, "event_id")

	hashableEventJSON, err := json.Marshal(event)
	if err != nil {
		return ""
	}

	hashableEventJSON, err = gomatrixserverlib.CanonicalJSON(hashableEventJSON)
	if err != nil {
		return ""
	}

	sha256Hash := sha256.Sum256(hashableEventJSON)
	var eventID string

	eventFormat := verImpl.EventFormat()
	eventIDFormat := verImpl.EventIDFormat()

	switch eventFormat {
	case gomatrixserverlib.EventFormatV1:
		if err = json.Unmarshal(existingEventID, &eventID); err != nil {
			return ""
		}
	case gomatrixserverlib.EventFormatV2:
		var encoder *base64.Encoding
		switch eventIDFormat {
		case gomatrixserverlib.EventIDFormatV2:
			encoder = base64.RawStdEncoding.WithPadding(base64.NoPadding)
		case gomatrixserverlib.EventIDFormatV3:
			encoder = base64.RawURLEncoding.WithPadding(base64.NoPadding)
		default:
			return ""
		}
		eventID = "$" + encoder.EncodeToString(sha256Hash[:])
	default:
		return ""
	}

	return eventID
}

func main() {
	wait := make(chan struct{}, 0)
	js.Global().Set("gmslEventIDForEvent", js.FuncOf(eventIDForEvent))
	<-wait
}
