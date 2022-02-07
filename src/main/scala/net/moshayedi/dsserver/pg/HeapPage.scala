package net.moshayedi.dsserver.pg

case class HeapPage(relation: String, page: Int, bytes: Array[Int])

