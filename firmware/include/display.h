#pragma once

#include <Arduino.h>
#include <string>
#include <vector>

void displayBegin();
void displayUpdate();
void displayShowBoot();
void displayShowStatus();
void displayShowButtonHold(unsigned long heldMs, const char* releaseAction, uint8_t progressPercent);
void displayClearButtonHold();
void displayShowButtonFeedback(const char* message);
void displayShowMenu(const char* title, const std::vector<std::string>& options, int selectedOption);
void displayClear();
void displayShowMessage(const char* title, const char* message, int size = 1);