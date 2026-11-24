package group

import "slices"

type BoardStroke struct {
	ID     uint64      `json:"id"`
	Mode   string      `json:"mode"`
	Color  string      `json:"color"`
	Points [][2]uint16 `json:"points"`
	author string
}

type BoardState struct {
	Version uint64        `json:"version"`
	Strokes []BoardStroke `json:"strokes"`
}

type BoardChange struct {
	Version uint64       `json:"version"`
	Stroke  *BoardStroke `json:"stroke,omitempty"`
	Remove  uint64       `json:"remove,omitempty"`
	Clear   bool         `json:"clear,omitempty"`
}

func (g *Group) Board() BoardState {
	g.mu.Lock()
	defer g.mu.Unlock()
	return BoardState{Version: g.board.Version, Strokes: slices.Clone(g.board.Strokes)}
}

func (g *Group) ChangeBoard(client Client, action string, value map[string]any) (BoardChange, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.clients[client.Id()] != client {
		return BoardChange{}, UserError("not authorised")
	}
	op := slices.Contains(client.Permissions(), "op")
	if !op && !slices.Contains(client.Permissions(), "message") {
		return BoardChange{}, UserError("not authorised")
	}
	b := &g.board

	change := BoardChange{Version: b.Version + 1}
	switch action {
	case "draw":
		mode, _ := value["mode"].(string)
		color, _ := value["color"].(string)
		response, ok := value["points"].([]any)
		if !ok || len(response) < 2 || len(response) > 90 || (mode != "pen" && mode != "box" && mode != "arrow") ||
			(color != "#182a28" && color != "#08714b" && color != "#2363b4" && color != "#be3828") {
			return BoardChange{}, UserError("invalid stroke")
		}
		if len(b.Strokes) >= 400 {
			return BoardChange{}, UserError("board is full")
		}
		points := make([][2]uint16, 0, len(response))
		for _, point := range response {
			coords, ok := point.([]any)
			if !ok || len(coords) != 2 {
				return BoardChange{}, UserError("invalid point")
			}
			x, okX := meetingInt(coords[0], 10000)
			y, okY := meetingInt(coords[1], 6250)
			if !okX || !okY {
				return BoardChange{}, UserError("invalid point")
			}
			points = append(points, [2]uint16{uint16(x), uint16(y)})
		}
		stroke := BoardStroke{ID: change.Version, Mode: mode, Color: color, Points: points, author: client.Id()}
		b.Strokes = append(b.Strokes, stroke)
		change.Stroke = &stroke
	case "undo":
		for i := len(b.Strokes) - 1; i >= 0; i-- {
			if b.Strokes[i].author == client.Id() {
				change.Remove = b.Strokes[i].ID
				b.Strokes = slices.Delete(b.Strokes, i, i+1)
				break
			}
		}
		if change.Remove == 0 {
			return BoardChange{}, UserError("no stroke to undo")
		}
	case "clear":
		if !op {
			return BoardChange{}, UserError("not authorised")
		}
		b.Strokes = nil
		change.Clear = true
	default:
		return BoardChange{}, UserError("unknown board action")
	}
	b.Version = change.Version
	return change, nil
}
