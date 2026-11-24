package group

import "testing"

func TestSharedBoardAuthorizationAndRevisions(t *testing.T) {
	host := &meetingTestClient{id: "host", permissions: []string{"op"}}
	drawer := &meetingTestClient{id: "drawer", permissions: []string{"message"}}
	observer := &meetingTestClient{id: "observer"}
	g := &Group{clients: map[string]Client{host.id: host, drawer.id: drawer, observer.id: observer}}
	stroke := map[string]any{"mode": "pen", "color": "#182a28", "points": []any{
		[]any{float64(10), float64(20)}, []any{float64(100), float64(200)},
	}}
	if _, err := g.ChangeBoard(observer, "draw", stroke); err == nil {
		t.Fatal("observer can draw")
	}
	a, err := g.ChangeBoard(host, "draw", stroke)
	if err != nil {
		t.Fatal(err)
	}
	b, err := g.ChangeBoard(drawer, "draw", stroke)
	if err != nil {
		t.Fatal(err)
	}
	if b.Version != a.Version+1 || len(g.Board().Strokes) != 2 {
		t.Fatal("wrong board state after two drawings")
	}
	if _, err := g.ChangeBoard(drawer, "clear", nil); err == nil {
		t.Fatal("participant can clear the board")
	}
	undo, err := g.ChangeBoard(drawer, "undo", nil)
	if err != nil || undo.Remove != b.Stroke.ID || len(g.Board().Strokes) != 1 {
		t.Fatalf("undo did not remove the participant's own last stroke: %+v %v", undo, err)
	}
	if _, err := g.ChangeBoard(drawer, "undo", nil); err == nil {
		t.Fatal("participant undid another user's stroke")
	}
	clear, err := g.ChangeBoard(host, "clear", nil)
	if err != nil || !clear.Clear || len(g.Board().Strokes) != 0 {
		t.Fatalf("operator could not clear the board: %+v %v", clear, err)
	}
}
