package net.moshayedi.dsserver

import cats.effect.{ExitCode, IO, IOApp}

object Main extends IOApp {
  def run(args: List[String]) =
    DSServer.stream[IO].compile.drain.as(ExitCode.Success)
}
