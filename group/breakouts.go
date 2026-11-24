package group

import (
	"crypto/rand"
	"encoding/hex"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type breakoutRound struct {
	rooms       []breakoutRoom
	assignments map[string]string
	closed      bool
}

type breakoutRoom struct {
	key   string
	group *Group
}

type BreakoutRoomStatus struct {
	Key   string `json:"key"`
	Title string `json:"title"`
	Count int    `json:"count"`
}

type BreakoutMember struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Room       string `json:"room"`
	Assignment string `json:"assignment"`
}

type BreakoutSnapshot struct {
	Active   bool                 `json:"active"`
	Current  string               `json:"current"`
	Assigned string               `json:"assigned"`
	Rooms    []BreakoutRoomStatus `json:"rooms,omitempty"`
	Members  []BreakoutMember     `json:"members,omitempty"`
}

func (g *Group) BreakoutRoot() *Group {
	if g.breakoutParent != nil {
		return g.breakoutParent
	}
	return g
}

func breakoutHuman(c Client) bool {
	p := c.Permissions()
	return !slices.Contains(p, "system") && !slices.Contains(p, "caption-on-demand")
}

func (g *Group) LaunchBreakouts(operator Client, titles []string, assignments map[string]string) error {
	groups.mu.Lock()
	defer groups.mu.Unlock()
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.breakoutParent != nil || g.clients[operator.Id()] != operator || !slices.Contains(operator.Permissions(), "op") {
		return UserError("not authorised")
	}
	if len(titles) < 2 || len(titles) > 8 {
		return UserError("choose between two and eight rooms")
	}
	if round := g.breakouts; round != nil {
		if !round.closed {
			return UserError("breakout rooms already open")
		}
		for _, room := range round.rooms {
			if room.group.ClientCount() > 0 {
				return UserError("participants are returning")
			}
		}
	}
	for i, title := range titles {
		title = strings.TrimSpace(title)
		if title == "" || utf8.RuneCountInString(title) > 48 {
			return UserError("invalid room name")
		}
		titles[i] = title
	}
	var nonce [10]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	round := &breakoutRound{assignments: make(map[string]string)}
	for i, title := range titles {
		key := strconv.Itoa(i + 1)
		name := g.Name() + "/breakout-" + hex.EncodeToString(nonce[:]) + "-" + key
		child := &Group{name: name, clients: make(map[string]Client), timestamp: time.Now(),
			breakoutParent: g, description: &Description{
				DisplayName: title, Codecs: slices.Clone(g.description.Codecs), MaxHistoryAge: 60,
			}}
		child.breakoutActive.Store(true)
		groups.groups[name] = child
		round.rooms = append(round.rooms, breakoutRoom{key: key, group: child})
	}
	for id, key := range assignments {
		if member := g.clients[id]; member != nil && breakoutHuman(member) &&
			slices.ContainsFunc(round.rooms, func(room breakoutRoom) bool { return room.key == key }) {
			round.assignments[id] = key
		}
	}
	g.breakouts = round
	return nil
}

func (g *Group) AssignBreakout(operator Client, id, key string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.clients[operator.Id()] != operator || !slices.Contains(operator.Permissions(), "op") {
		return UserError("not authorised")
	}
	round := g.breakouts
	if round == nil || round.closed {
		return UserError("breakout rooms are closed")
	}
	member := g.clients[id]
	if member == nil || !breakoutHuman(member) {
		return UserError("participant is no longer in the main room")
	}
	if key == "" {
		delete(round.assignments, id)
		return nil
	}
	if !slices.ContainsFunc(round.rooms, func(room breakoutRoom) bool { return room.key == key }) {
		return UserError("unknown breakout room")
	}
	round.assignments[id] = key
	return nil
}

func (g *Group) BreakoutView(client Client, current *Group) BreakoutSnapshot {
	root := g.BreakoutRoot()
	root.mu.Lock()
	defer root.mu.Unlock()
	var snapshot BreakoutSnapshot
	if round := root.breakouts; round != nil {
		snapshot.Active = !round.closed
		snapshot.Assigned = round.assignments[client.Id()]
		op := slices.Contains(client.Permissions(), "op")
		appendMembers := func(clients []Client, key string) int {
			count := 0
			for _, member := range clients {
				if !breakoutHuman(member) {
					continue
				}
				count++
				if op {
					snapshot.Members = append(snapshot.Members, BreakoutMember{member.Id(), member.Username(), key, round.assignments[member.Id()]})
				}
			}
			return count
		}
		appendMembers(root.getClientsUnlocked(nil), "")
		for _, room := range round.rooms {
			if room.group == current {
				snapshot.Current = room.key
			}
			count := appendMembers(room.group.GetClients(nil), room.key)
			if op || room.key == snapshot.Assigned || room.group == current {
				snapshot.Rooms = append(snapshot.Rooms, BreakoutRoomStatus{room.key, room.group.Description().DisplayName, count})
			}
		}
	}
	return snapshot
}

func (g *Group) BreakoutClients() []Client {
	g.mu.Lock()
	defer g.mu.Unlock()
	clients := g.getClientsUnlocked(nil)
	if g.breakouts != nil {
		for _, room := range g.breakouts.rooms {
			clients = append(clients, room.group.GetClients(nil)...)
		}
	}
	return clients
}

type BreakoutReturn struct {
	Client Client
	Room   *Group
}

func (g *Group) CloseBreakouts(operator Client) ([]BreakoutReturn, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.clients[operator.Id()] != operator || !slices.Contains(operator.Permissions(), "op") {
		return nil, UserError("not authorised")
	}
	if g.breakouts == nil || g.breakouts.closed {
		return nil, UserError("breakout rooms are closed")
	}
	g.breakouts.closed = true
	var returning []BreakoutReturn
	for _, room := range g.breakouts.rooms {
		room.group.breakoutActive.Store(false)
		for _, member := range room.group.GetClients(nil) {
			returning = append(returning, BreakoutReturn{member, room.group})
		}
	}
	return returning, nil
}

// MoveBreakout transfers a client authenticated in the main room. The caller
// must close its previous media and update its group after a successful move.
func (g *Group) MoveBreakout(client Client, current *Group, key string, reset func()) (*Group, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if current.BreakoutRoot() != g || g.breakouts == nil {
		return nil, UserError("breakout rooms are unavailable")
	}
	round := g.breakouts
	target := g
	if key != "" {
		if round.closed || (!slices.Contains(client.Permissions(), "op") && round.assignments[client.Id()] != key) {
			return nil, UserError("you are not assigned to this room")
		}
		i := slices.IndexFunc(round.rooms, func(room breakoutRoom) bool { return room.key == key })
		if i < 0 {
			return nil, UserError("unknown breakout room")
		}
		target = round.rooms[i].group
	}
	if target == current {
		return nil, nil
	}
	if current != g {
		current.mu.Lock()
		defer current.mu.Unlock()
	}
	if target != g {
		target.mu.Lock()
		defer target.mu.Unlock()
	}
	if current.clients[client.Id()] != client || target.clients[client.Id()] != nil {
		return nil, UserError("participant is no longer available")
	}
	delete(current.clients, client.Id())
	current.timestamp = time.Now()
	for _, peer := range current.getClientsUnlocked(nil) {
		peer.PushClient(current.Name(), "delete", client.Id(), client.Username(), nil, nil)
	}
	reset()
	if err := target.addClientUnlocked(client, target.getClientsUnlocked(nil), "move"); err != nil {
		return nil, err
	}
	return target, nil
}

func (g *Group) PruneBreakouts() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.breakouts == nil || g.breakouts.closed || slices.ContainsFunc(g.getClientsUnlocked(nil), breakoutHuman) {
		return
	}
	for _, room := range g.breakouts.rooms {
		if room.group.ClientCount() > 0 {
			return
		}
	}
	g.breakouts.closed = true
	for _, room := range g.breakouts.rooms {
		room.group.breakoutActive.Store(false)
	}
}
