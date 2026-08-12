#pragma once

#include <stdint.h>
#include <string>
#include <vector>

void displayBegin();
void displayUpdate();
void displayShowBoot();
void displayShowStatus();
void displayShowMenu(const char* title, const std::vector<std::string>& items, int selected);
void displayShowMessage(const char* line1, const char* line2, int delayMs = 0);
void displayClear();
void displayShowButtonHold(unsigned long heldMs, const char* releaseAction, uint8_t progressPercent);
void displayClearButtonHold();
void displayShowButtonFeedback(const char* message);
