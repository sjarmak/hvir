package store

import (
	"context"

	"example.com/shop/pkg/api"
)

type Store struct{}

type Key = api.ID

func New() *Store { return &Store{} }

func (s *Store) Get(ctx context.Context, key Key) api.Item {
	type local struct{}
	return api.Item{}
}
