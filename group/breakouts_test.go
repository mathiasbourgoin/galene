package group

import "testing"

type breakoutTestClient struct {
	meetingTestClient
	lastJoin string
}

func (c *breakoutTestClient) Joined(_ string, kind string) error {
	c.lastJoin = kind
	return nil
}
func (c *breakoutTestClient) Data() map[string]interface{} { return nil }
func (c *breakoutTestClient) PushClient(_, _, _, _ string, _ []string, _ map[string]interface{}) error {
	return nil
}

func TestBreakoutTransfers(t *testing.T) {
	root, err := Add(t.Name(), &Description{DisplayName: "Main group"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		groups.mu.Lock()
		defer groups.mu.Unlock()
		delete(groups.groups, root.Name())
		if root.breakouts != nil {
			for _, room := range root.breakouts.rooms {
				delete(groups.groups, room.group.Name())
			}
		}
	})
	host := &breakoutTestClient{meetingTestClient: meetingTestClient{id: "host", permissions: []string{"op"}}}
	guest := &breakoutTestClient{meetingTestClient: meetingTestClient{id: "guest", permissions: []string{"message", "present"}}}
	root.clients[host.Id()] = host
	root.clients[guest.Id()] = guest
	titles := []string{"Design", "Review"}
	assignments := map[string]string{guest.Id(): "2"}
	if err := root.LaunchBreakouts(guest, titles, assignments); err == nil {
		t.Fatal("guest could open breakout rooms")
	}
	if err := root.LaunchBreakouts(host, titles, assignments); err != nil {
		t.Fatal(err)
	}
	clears := 0
	reset := func() { clears++ }
	if _, err := root.MoveBreakout(guest, root, "1", reset); err == nil {
		t.Fatal("guest could join an unassigned room")
	}
	design := root.breakouts.rooms[0].group
	if _, err := AddClient(design.Name(), guest, ClientCredentials{}); err == nil {
		t.Fatal("ordinary login could enter a temporary room")
	}
	room, err := root.MoveBreakout(guest, root, "2", reset)
	if err != nil || room == nil || guest.lastJoin != "move" || root.ClientCount() != 1 || clears != 1 {
		t.Fatalf("failed to move guest exactly once: %v", err)
	}
	if view := root.BreakoutView(guest, room); len(view.Rooms) != 1 || view.Current != "2" || len(view.Members) != 0 {
		t.Fatalf("wrong non-operator view: %+v", view)
	}
	returning, err := root.CloseBreakouts(host)
	if err != nil || len(returning) != 1 || returning[0].Client != guest || returning[0].Room != room {
		t.Fatalf("failed to recall the guest: %v", err)
	}
	got, err := root.MoveBreakout(guest, room, "", reset)
	if err != nil || got != root || root.ClientCount() != 2 || room.ClientCount() != 0 || clears != 2 {
		t.Fatalf("failed to return to the main group: %v", err)
	}
	if _, err := root.MoveBreakout(guest, root, "2", reset); err == nil {
		t.Fatal("guest entered a closed round")
	}
}
