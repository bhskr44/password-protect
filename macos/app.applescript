-- Password Protect: the Mac front end. All encryption happens in the bundled
-- `protect` program; this file only collects choices through native dialogs.
--
-- Never put the password in a `do shell script` command: the whole command
-- becomes an argument of sh, visible in the process list while it runs.
-- runTool starts `protect` directly and writes the password to its stdin.

use AppleScript version "2.5"
use framework "Foundation"
use scripting additions

property appName : "Password Protect"
property minLength : 8

on run
	set choice to button returned of (display dialog "Lock or unlock something, or drop files and folders onto this app." with title appName buttons {"History & SHA-256…", "Choose Folder…", "Choose File…"} default button 3)
	if choice is "History & SHA-256…" then
		showTools()
	else if choice is "Choose File…" then
		handleItem(choose file with prompt "Choose a file to lock or unlock")
	else
		handleItem(choose folder with prompt "Choose a folder to lock")
	end if
end run

on showTools()
	set tool to button returned of (display dialog "Show the record of this Mac, or the SHA-256 of anything." with title appName buttons {"SHA-256 of Folder…", "SHA-256 of File…", "View History"} default button 3)
	if tool is "View History" then
		my showMessage(my runProtect({"history", "--limit", "5"}, ""))
	else if tool is "SHA-256 of File…" then
		my showMessage(my runProtect({"hash", POSIX path of (choose file)}, ""))
	else
		my showMessage(my runProtect({"hash", trimSlash(POSIX path of (choose folder))}, ""))
	end if
end showTools

on open droppedItems
	repeat with droppedItem in droppedItems
		handleItem(droppedItem)
	end repeat
end open

on handleItem(theItem)
	set itemPath to POSIX path of (theItem as alias)
	set itemPath to trimSlash(itemPath)
	try
		if isLocked(itemPath) then
			if my askLockedAction(baseName(itemPath)) is "Verify" then
				verifyItem(itemPath)
			else
				unlockItem(itemPath)
			end if
		else if itemPath ends with ".zip" and my askZipAction(baseName(itemPath)) is "Extract" then
			my showMessage(my runProtect({"unzip", itemPath}, ""))
		else
			lockItem(itemPath)
		end if
	on error errorText number errorNumber
		if errorNumber is not -128 then my showError(errorText)
	end try
end handleItem

-- POSIX paths of folders end in a slash, which would hide the folder's name.
on trimSlash(itemPath)
	if itemPath ends with "/" and itemPath is not "/" then return text 1 thru -2 of itemPath
	return itemPath
end trimSlash

-- Dialogs stay in small handlers, called through `my`, so that
-- macos/test-flow.applescript can replace them and test every path.

-- Must match MAGIC in lib/protect.js.
on isLocked(itemPath)
	return (do shell script "head -c 6 " & quoted form of itemPath & " 2>/dev/null || true") is "PROTC1"
end isLocked

on lockItem(itemPath)
	set itemName to baseName(itemPath)
	set secret to my askPassword("Choose a password for “" & itemName & "”." & return & return & "A forgotten password cannot be recovered.")
	considering case
		set matches to secret is my askPassword("Enter the password again.")
	end considering
	if not matches then error "The passwords do not match. Nothing was changed."
	if (count of secret) < minLength then error "Use a password of at least " & minLength & " characters. Nothing was changed."

	set choice to my askDelete(itemName)
	set arguments to {"lock", itemPath}
	if choice is "Delete Original" then set end of arguments to "--remove"

	my showMessage(my runProtect(arguments, secret))
end lockItem

on unlockItem(itemPath)
	set secret to my askPassword("Enter the password for “" & baseName(itemPath) & "”.")
	set arguments to {"unlock", itemPath}
	if itemPath ends with ".zip.locked" then set end of arguments to "--unzip"
	my showMessage(my runProtect(arguments, secret))
end unlockItem

on askPassword(promptText)
	return text returned of (display dialog promptText with title appName default answer "" with hidden answer buttons {"Cancel", "Continue"} default button 2 cancel button 1)
end askPassword

on verifyItem(itemPath)
	set secret to my askPassword("Enter the password for “" & baseName(itemPath) & "” to check what is inside. Nothing will be unlocked.")
	set expected to my askExpected()
	set arguments to {"verify", itemPath}
	if expected is not "" then set arguments to arguments & {"--against", expected}
	my showMessage(my runProtect(arguments, secret))
end verifyItem

on askLockedAction(itemName)
	return button returned of (display dialog "“" & itemName & "” is locked. Verify checks its SHA-256 and who locked it, without unlocking it." with title appName buttons {"Cancel", "Verify", "Unlock"} default button 3 cancel button 1)
end askLockedAction

on askExpected()
	return text returned of (display dialog "To compare with another machine, paste its SHA-256. Otherwise leave this empty." with title appName default answer "" buttons {"Cancel", "Continue"} default button 2 cancel button 1)
end askExpected

on askZipAction(itemName)
	return button returned of (display dialog "What would you like to do with “" & itemName & "”?" with title appName buttons {"Cancel", "Lock", "Extract"} default button 3 cancel button 1)
end askZipAction

on askDelete(itemName)
	return button returned of (display dialog "Delete the unencrypted “" & itemName & "” after locking?" & return & return & "It is only deleted once the locked copy has been verified. If you keep it, anyone can still open the original." with title appName buttons {"Cancel", "Keep Original", "Delete Original"} default button 3 cancel button 1)
end askDelete

on showMessage(messageText)
	display dialog messageText with title appName buttons {"OK"} default button 1
end showMessage

on showError(errorText)
	display alert appName message errorText as critical
end showError

on runProtect(arguments, secret)
	return runTool(POSIX path of (path to me) & "Contents/Resources/protect", arguments, secret)
end runProtect

-- Runs the program with no shell involved and returns its output, or raises an
-- error carrying that output if it fails.
on runTool(program, arguments, secret)
	set NSUTF8StringEncoding to 4
	set task to current application's NSTask's alloc()'s init()
	task's setExecutableURL:(current application's NSURL's fileURLWithPath:program)
	task's setArguments:(arguments & {"--password-stdin"})
	set inputPipe to current application's NSPipe's pipe()
	set outputPipe to current application's NSPipe's pipe()
	task's setStandardInput:inputPipe
	task's setStandardOutput:outputPipe
	task's setStandardError:outputPipe
	set {started, launchError} to task's launchAndReturnError:(reference)
	if not started then error (launchError's localizedDescription()) as text

	set writer to inputPipe's fileHandleForWriting()
	writer's writeData:((current application's NSString's stringWithString:secret)'s dataUsingEncoding:NSUTF8StringEncoding)
	writer's closeFile()

	set outputData to outputPipe's fileHandleForReading()'s readDataToEndOfFile()
	task's waitUntilExit()
	set output to (current application's NSString's alloc()'s initWithData:outputData encoding:NSUTF8StringEncoding) as text
	if (task's terminationStatus() as integer) is not 0 then error output
	return output
end runTool

on baseName(itemPath)
	set AppleScript's text item delimiters to "/"
	set name_ to last text item of itemPath
	set AppleScript's text item delimiters to ""
	return name_
end baseName
