package main

import "fmt"

import (
	"example.com/shop"
	"example.com/shop/internal/store"
	api "example.com/shop/pkg/api"
	uuid "github.com/google/uuid"
	_ "example.com/shop/internal/missing"
	. `example.com/shop/internal/store/sqlite`
	"example.com/shop/hack/tmpl"
)

func main() {
	fmt.Println(shop.Version(), store.New(), api.Handle(), uuid.New(), Open(), tmpl.T)
}
