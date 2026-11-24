package group

import "testing"

type meetingTestClient struct {
	Client
	id          string
	permissions []string
}

func (c *meetingTestClient) Id() string            { return c.id }
func (c *meetingTestClient) Permissions() []string { return c.permissions }
func (c *meetingTestClient) Username() string      { return c.id }

func TestMeetingPermissionsAndSnapshots(t *testing.T) {
	host := &meetingTestClient{id: "host", permissions: []string{"op"}}
	guest := &meetingTestClient{id: "guest", permissions: []string{"message"}}
	other := &meetingTestClient{id: "other", permissions: []string{"message"}}
	g := &Group{clients: map[string]Client{host.id: host, guest.id: guest, other.id: other}}

	open := map[string]any{"question": "Which one?", "options": []any{"A", "B"}}
	if err := g.ChangeMeeting(guest, "poll-open", open); err == nil {
		t.Fatal("guest opened a poll")
	}
	if err := g.ChangeMeeting(host, "poll-open", open); err != nil {
		t.Fatal(err)
	}
	vote := map[string]any{"id": float64(g.Meeting(host).Poll.ID), "option": float64(0)}
	if err := g.ChangeMeeting(guest, "poll-vote", vote); err != nil {
		t.Fatal(err)
	}
	vote["option"] = float64(1)
	if err := g.ChangeMeeting(guest, "poll-vote", vote); err != nil {
		t.Fatal(err)
	}
	if p := g.Meeting(other).Poll; p.Counts != nil || p.Vote != nil {
		t.Fatal("another participant saw a live vote")
	}
	if p := g.Meeting(host).Poll; p.Counts[0] != 0 || p.Counts[1] != 1 {
		t.Fatalf("a second vote must replace the original: %v", p.Counts)
	}
	if err := g.ChangeMeeting(host, "poll-close", vote); err != nil {
		t.Fatal(err)
	}
	if p := g.Meeting(other).Poll; !p.Closed || p.Counts[1] != 1 || p.Vote != nil {
		t.Fatal("published results did not preserve voter privacy")
	}
	if err := g.ChangeMeeting(host, "notes-save", map[string]any{"version": float64(0), "text": "decision"}); err != nil {
		t.Fatal(err)
	}
	if err := g.ChangeMeeting(host, "notes-save", map[string]any{"version": float64(0), "text": "stale"}); err == nil {
		t.Fatal("stale edit silently replaced the meeting notes")
	}
	if notes := g.Meeting(guest).Notes; notes != "decision" {
		t.Fatalf("unexpected notes: %q", notes)
	}
}
