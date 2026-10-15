' start-ocserver-hidden.vbs
'
' Hidden launcher for deploy\start-ocserver.cmd (scheduled task ZenOcServer).
' ASCII only on purpose: wscript.exe reads this as ANSI/GBK.

Option Explicit

Dim shell, fso, scriptDir, cmdPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
cmdPath = scriptDir & "\start-ocserver.cmd"

If Not fso.FileExists(cmdPath) Then
  WScript.Echo "start-ocserver.cmd not found: " & cmdPath
  WScript.Quit 1
End If

shell.Run "cmd.exe /d /c """ & cmdPath & """", 0, False
