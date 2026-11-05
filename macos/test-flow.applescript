-- Runs the app's real lock and unlock paths on the built app, with its dialogs
-- replaced by scripted answers. Usage: osascript test-flow.applescript <app>

property failures : {}
on check(label, passed)
	if passed then
		log "ok   " & label
	else
		set end of failures to label
		log "FAIL " & label
	end if
end check

on exists_(thePath)
	return (do shell script "[ -e " & quoted form of thePath & " ] && echo y || echo n") is "y"
end exists_

on contents_(thePath)
	return do shell script "cat " & quoted form of thePath
end contents_

on run argv
	set appPath to item 1 of argv
	set program to appPath & "/Contents/Resources/protect"
	set appScript to load script POSIX file (appPath & "/Contents/Resources/Scripts/main.scpt")

	script fake
		property parent : appScript
		on askPassword(promptText)
			set answer to item 1 of my outer's answers
			set my outer's answers to rest of my outer's answers
			return answer
		end askPassword
		on askDelete(itemName)
			return my outer's deleteChoice
		end askDelete
		on askZipAction(itemName)
			return my outer's zipAction
		end askZipAction
		on askLockedAction(itemName)
			return my outer's lockedAction
		end askLockedAction
		on askExpected()
			return my outer's expectedSha
		end askExpected
		on showMessage(messageText)
			set my outer's lastMessage to messageText
		end showMessage
		on showError(errorText)
			set end of my outer's shownErrors to errorText
		end showError
		on runProtect(arguments, secret)
			return appScript's runTool(my outer's programPath, arguments, secret)
		end runProtect
		property outer : missing value
	end script

	script state
		property answers : {}
		property deleteChoice : "Keep Original"
		property zipAction : "Extract"
		property lastMessage : ""
		property lockedAction : "Unlock"
		property expectedSha : ""
		property shownErrors : {}
		property programPath : program
	end script
	set fake's outer to state

	set tempDir to do shell script "mktemp -d"
	set strongPass to "Str0ng pass'word \"✓\""

	-- Lock a file, keeping the original
	set notePath to tempDir & "/my note.txt"
	do shell script "printf hello > " & quoted form of notePath
	set state's answers to {strongPass, strongPass}
	fake's handleItem(POSIX file notePath)
	check("lock keeps original", exists_(notePath) and exists_(notePath & ".locked") and (count of state's shownErrors) is 0)
	check("lock reports the SHA-256", state's lastMessage contains "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")

	-- Unlock with the wrong password
	do shell script "rm " & quoted form of notePath
	set state's answers to {"completely wrong password"}
	fake's handleItem(POSIX file (notePath & ".locked"))
	check("wrong password shows error", (count of state's shownErrors) is 1 and not exists_(notePath))
	set state's shownErrors to {}

	-- Unlock with the right password
	set state's answers to {strongPass}
	fake's handleItem(POSIX file (notePath & ".locked"))
	check("unlock restores contents", exists_(notePath) and contents_(notePath) is "hello" and (count of state's shownErrors) is 0)

	check("unlock reports it matches", state's lastMessage contains "Verified")
	set historyText to fake's runProtect({"history", "--limit", "2"}, "")
	check("history records both events", historyText contains "UNLOCK" and historyText contains "LOCK")

	-- Verify against the SHA from another machine, right and wrong
	set helloSha to "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	set state's lockedAction to "Verify"
	set state's expectedSha to helloSha
	set state's answers to {strongPass}
	do shell script "rm " & quoted form of notePath
	fake's handleItem(POSIX file (notePath & ".locked"))
	check("verify reports a match and restores nothing", state's lastMessage contains "MATCH: identical" and not exists_(notePath))
	set state's expectedSha to "0000000000000000000000000000000000000000000000000000000000000000"
	set state's answers to {strongPass}
	fake's handleItem(POSIX file (notePath & ".locked"))
	check("verify reports a mismatch", (count of state's shownErrors) is 1 and (item 1 of state's shownErrors) contains "DOES NOT MATCH")
	set state's shownErrors to {}
	set state's lockedAction to "Unlock"

	-- Lock a folder and delete the original
	set folder_ to tempDir & "/My Folder"
	do shell script "mkdir -p " & quoted form of (folder_ & "/sub") & " && printf inner > " & quoted form of (folder_ & "/sub/f")
	set state's deleteChoice to "Delete Original"
	set state's answers to {strongPass, strongPass}
	fake's handleItem(POSIX file folder_)
	check("folder locked and original deleted", exists_(folder_ & ".locked") and not exists_(folder_) and (count of state's shownErrors) is 0)

	set state's answers to {strongPass}
	fake's handleItem(POSIX file (folder_ & ".locked"))
	check("folder restored", contents_(folder_ & "/sub/f") is "inner")

	-- Passwords must match, including case
	set otherPath to tempDir & "/other.txt"
	do shell script "printf x > " & quoted form of otherPath
	set state's deleteChoice to "Keep Original"
	set state's answers to {"CaseMatters1", "casematters1"}
	fake's handleItem(POSIX file otherPath)
	check("passwords differing by case refused", (count of state's shownErrors) is 1 and not exists_(otherPath & ".locked"))
	set state's shownErrors to {}

	-- Short passwords
	set state's answers to {"short", "short"}
	fake's handleItem(POSIX file otherPath)
	check("short password refused", (count of state's shownErrors) is 1 and not exists_(otherPath & ".locked"))

	-- Extract a plain zip without any password
	set zipDir to tempDir & "/My Zip"
	do shell script "mkdir " & quoted form of zipDir & " && printf zipped > " & quoted form of (zipDir & "/z.txt") & " && cd " & quoted form of tempDir & " && /usr/bin/ditto -c -k --keepParent 'My Zip' 'My Zip.zip' && rm -r 'My Zip'"
	fake's handleItem(POSIX file (zipDir & ".zip"))
	check("plain zip extracts", contents_(zipDir & "/z.txt") is "zipped" and (count of state's shownErrors) is 1)
	do shell script "rm -r " & quoted form of zipDir

	-- Choosing Lock on a zip locks it, and unlocking it also extracts it
	set state's zipAction to "Lock"
	set state's deleteChoice to "Delete Original"
	set state's answers to {strongPass, strongPass}
	fake's handleItem(POSIX file (zipDir & ".zip"))
	check("zip can be locked", exists_(zipDir & ".zip.locked") and not exists_(zipDir & ".zip"))
	set state's answers to {strongPass}
	fake's handleItem(POSIX file (zipDir & ".zip.locked"))
	check("locked zip unlocks and extracts", exists_(zipDir & ".zip") and contents_(zipDir & "/z.txt") is "zipped" and (count of state's shownErrors) is 1)

	do shell script "rm -rf " & quoted form of tempDir
	if (count of failures) > 0 then error "App flow tests failed: " & (count of failures)
	return "App flow tests passed"
end run
