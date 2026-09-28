package app.service

import app.model.User
import app.model.DEFAULT_USER as DefaultUser
import app.model.createUser
import app.missing.Missing
import kotlin.collections.*

class Service {
  fun load(): User = createUser()
}
