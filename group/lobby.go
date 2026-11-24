package group

import (
	"cmp"
	"errors"
	"slices"
	"time"
)

var ErrWaitingForAdmission = errors.New("waiting for admission")

type LobbyEntry struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Arrival  int64  `json:"arrival"`
}

type waitingClient struct {
	client Client
	time   time.Time
}

func (g *Group) Waiting() []LobbyEntry {
	g.mu.Lock()
	defer g.mu.Unlock()

	waiting := make([]LobbyEntry, 0, len(g.lobby))
	for id, entry := range g.lobby {
		waiting = append(waiting, LobbyEntry{ID: id, Username: entry.client.Username(), Arrival: entry.time.UnixMilli()})
	}
	slices.SortFunc(waiting, func(a, b LobbyEntry) int {
		if order := cmp.Compare(a.Arrival, b.Arrival); order != 0 {
			return order
		}
		return cmp.Compare(a.ID, b.ID)
	})
	return waiting
}

func (g *Group) WaitingClient(id string) Client {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.lobby[id].client
}

func (g *Group) RemoveWaiting(client Client) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.lobby[client.Id()].client == client {
		delete(g.lobby, client.Id())
		g.timestamp = time.Now()
	}
}

func (g *Group) AdmitWaiting(client Client) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.lobby[client.Id()].client != client {
		return UserError("guest is no longer waiting")
	}
	if g.locked != nil {
		return UserError("this group is locked")
	}
	if g.description.MaxClients > 0 && len(g.clients) >= g.description.MaxClients {
		return UserError("too many users")
	}
	delete(g.lobby, client.Id())
	return g.addClientUnlocked(client, g.getClientsUnlocked(nil))
}
