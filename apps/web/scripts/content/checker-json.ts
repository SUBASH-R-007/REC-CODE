/**
 * The C++ reader shared by the testlib checkers of the CUSTOM_CHECKER seed
 * problems (session-order, exact-change-pair, no-neighbour-seating).
 *
 * A FUNCTION-mode checker sees the harness's canonical JSON, one value per
 * line: input.txt has one line per parameter, answer.txt the jury's value and
 * output.txt the contestant's value (the judge decodes it strictly and
 * re-serialises it canonically before the checker runs). Each checker is
 * still one self-contained source file: the module that owns it pastes this
 * reader into its source text, so the frozen checker never depends on code
 * outside the file.
 *
 * Errors are attributed by the stream a line came from: a malformed line in
 * output.txt is the contestant's wrong answer (_wa); one in input.txt or
 * answer.txt is a broken test (_fail), which the judge reports to admins.
 */
export const CHECKER_JSON_READER = String.raw`// One line of canonical JSON made of integers and (nested) lists of integers.
class JsonLine {
public:
    JsonLine(std::string text, TResult onError, std::string what)
        : s_(std::move(text)), onError_(onError), what_(std::move(what)) {}

    long long integer(long long lo, long long hi) {
        skipSpace();
        bool negative = p_ < s_.size() && s_[p_] == '-';
        if (negative) ++p_;
        size_t start = p_;
        while (p_ < s_.size() && s_[p_] >= '0' && s_[p_] <= '9') ++p_;
        size_t digits = p_ - start;
        if (digits == 0) bad("expected an integer");
        if (digits > 1 && s_[start] == '0') bad("an integer has a leading zero");
        if (digits > 18) bad("an integer is out of range");
        long long value = std::stoll(s_.substr(start, digits));
        if (negative) value = -value;
        if (value < lo || value > hi) {
            quitf(onError_, "%s: %lld is outside [%lld, %lld]", what_.c_str(), value, lo, hi);
        }
        return value;
    }

    std::vector<long long> list(long long lo, long long hi) {
        std::vector<long long> out;
        expect('[');
        if (consume(']')) return out;
        do out.push_back(integer(lo, hi)); while (consume(','));
        expect(']');
        return out;
    }

    std::vector<std::vector<long long>> matrix(long long lo, long long hi) {
        std::vector<std::vector<long long>> out;
        expect('[');
        if (consume(']')) return out;
        do out.push_back(list(lo, hi)); while (consume(','));
        expect(']');
        return out;
    }

    /** Nothing but whitespace may follow the value. */
    void end() {
        skipSpace();
        if (p_ != s_.size()) bad("unexpected text after the value");
    }

private:
    std::string s_;
    size_t p_ = 0;
    TResult onError_;
    std::string what_;

    [[noreturn]] void bad(const char* why) {
        quitf(onError_, "%s: %s at character %d", what_.c_str(), why, (int)p_ + 1);
    }
    void skipSpace() {
        while (p_ < s_.size() && (s_[p_] == ' ' || s_[p_] == '\t' || s_[p_] == '\r' || s_[p_] == '\n')) ++p_;
    }
    bool consume(char c) {
        skipSpace();
        if (p_ < s_.size() && s_[p_] == c) {
            ++p_;
            return true;
        }
        return false;
    }
    void expect(char c) {
        if (!consume(c)) {
            std::string why = std::string("expected '") + c + "'";
            bad(why.c_str());
        }
    }
};
`;

/** A complete testlib checker: the includes, the shared reader, then the problem's own code. */
export function functionChecker(header: string, body: string): string {
  return `#include "testlib.h"
#include <climits>
#include <string>
#include <utility>
#include <vector>

${header.trim()}

${CHECKER_JSON_READER}
${body.trim()}
`;
}
